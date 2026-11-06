package com.libretv.app

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  @Volatile
  private var playerFullscreen = false

  // DLNA 投屏需要收发 SSDP 组播包（239.255.255.250:1900），
  // Android WiFi 默认过滤组播，必须持有 MulticastLock 才能收到设备应答。
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null

  // 投屏保活锁（WakeLock/WifiLock）与常驻通知的所有权已移入 CastKeepAliveService，
  // MainActivity 仅通过 keepAwake(true/false) 启停该前台服务。

  // ---- 屏幕开关事件日志（投屏诊断用）----
  // 「熄屏后投屏中断」排查的关键时间轴：把屏幕亮/灭时刻记下来，诊断报告里
  // 与代理的连接轨迹对照，即可区分「熄屏导致网络被限」（灭屏后连接送出骤降）
  // 还是上游/电视侧问题（时间对不上）。
  private var screenReceiver: android.content.BroadcastReceiver? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    super.onCreate(savedInstanceState)

    try {
      val wifi = applicationContext.getSystemService(WIFI_SERVICE) as android.net.wifi.WifiManager
      multicastLock = wifi.createMulticastLock("LibreTV-DLNA").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (e: Exception) {
      // 无 WiFi 权限等场景下静默失败，投屏功能不可用但不影响 App 其他功能
    }

    // 屏幕亮灭时间戳（只记录，不做任何业务逻辑）
    try {
      val receiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context?, intent: android.content.Intent?) {
          val label = when (intent?.action) {
            android.content.Intent.ACTION_SCREEN_OFF -> "屏幕关闭"
            android.content.Intent.ACTION_SCREEN_ON -> "屏幕点亮"
            else -> return
          }
          recordScreenEvent(label)
        }
      }
      val filter = android.content.IntentFilter().apply {
        addAction(android.content.Intent.ACTION_SCREEN_OFF)
        addAction(android.content.Intent.ACTION_SCREEN_ON)
      }
      // ACTION_SCREEN_ON/OFF 是受保护系统广播，兼容库注册在全部版本都安全
      androidx.core.content.ContextCompat.registerReceiver(
        this, receiver, filter, androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED
      )
      screenReceiver = receiver
    } catch (e: Exception) {
      // 注册失败只影响诊断信息，不影响功能
    }

    // 网络变化回调：Wi-Fi/流量切换、熄屏后网络恢复时通知 WebView → JS 调用
    // reset_http_client 重建 Rust 上游客户端，丢弃可能已被系统黑洞的连接池
    // （熄屏断流修复的一环：池内死连接会让亮屏后的首个请求继续超时）。
    try {
      val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
      cm.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: android.net.Network) {
          notifyNetworkChanged()
        }

        override fun onLost(network: android.net.Network) {
          notifyNetworkChanged()
        }
      })
    } catch (e: Exception) {
      // 回调失败只影响恢复速度，不影响功能
    }

    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.BLACK
    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }

    // The page draws edge-to-edge, so keep it clear of the system bars, cutout and keyboard ourselves.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.BLACK)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      if (playerFullscreen) {
        view.setPadding(0, 0, 0, 0)
      } else {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      }
      WindowInsetsCompat.CONSUMED
    }
  }

  @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.addJavascriptInterface(PlayerBridge(), "LibreTVAndroid")
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (playerFullscreen && event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (event.action == KeyEvent.ACTION_UP) {
        val view = webView
        if (view == null) {
          applyFullscreen(false, false)
        } else {
          view.evaluateJavascript("(window.__libretvNativeBack && window.__libretvNativeBack()) === true") { result ->
            if (result != "true") applyFullscreen(false, false)
          }
        }
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && playerFullscreen) hideSystemBars()
  }

  override fun onDestroy() {
    try {
      screenReceiver?.let { unregisterReceiver(it) }
    } catch (e: Exception) { /* 未注册成功等场景忽略 */ }
    screenReceiver = null
    super.onDestroy()
  }

  private fun hideSystemBars() {
    WindowInsetsControllerCompat(window, window.decorView).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  private fun applyFullscreen(enabled: Boolean, landscape: Boolean) {
    playerFullscreen = enabled
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = if (enabled) {
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        } else {
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
        }
      }
    }
    if (enabled) {
      hideSystemBars()
      requestedOrientation = if (landscape) {
        ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      } else {
        ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      }
    } else {
      WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }
    findViewById<View>(android.R.id.content)?.let { ViewCompat.requestApplyInsets(it) }
  }

  /**
   * Android 13+ 需要运行时授予 POST_NOTIFICATIONS，否则常驻通知不会显示在通知栏
   * （前台服务本身仍会运行，用户可在「前台服务任务管理器」里看到）。
   * 仅在首次需要时申请；用户拒绝后不再反复打扰，投屏保活不受影响。
   */
  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val granted = ContextCompat.checkSelfPermission(
      this,
      android.Manifest.permission.POST_NOTIFICATIONS
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) return
    runOnUiThread {
      try {
        requestPermissions(
          arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
          1001
        )
      } catch (e: Exception) {
        // 申请失败静默忽略：保活服务不依赖通知权限
      }
    }
  }

  /** 屏幕事件日志（时间戳字符串，最多 12 条，跨线程安全）。 */
  private val screenEvents: MutableList<String> =
    java.util.Collections.synchronizedList(ArrayList())

  private fun recordScreenEvent(label: String) {
    val ts = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
    synchronized(screenEvents) {
      screenEvents.add("$ts $label")
      while (screenEvents.size > 12) screenEvents.removeAt(0)
    }
  }

  /** 网络变化通知 WebView（JS 侧 __libretvNetworkChanged → reset_http_client）。 */
  private fun notifyNetworkChanged() {
    runOnUiThread {
      try {
        webView?.evaluateJavascript(
          "(window.__libretvNetworkChanged && window.__libretvNetworkChanged()) === true",
          null
        )
      } catch (e: Exception) { /* WebView 未就绪等场景忽略 */ }
    }
  }

  inner class PlayerBridge {
    // 进入播放页时记录原始音量与亮度，退出时还原
    private var originalVolume = -1
    private var originalBrightness = Float.NaN

    // 诊断用：屏幕亮灭时间轴（最近 12 条）
    @JavascriptInterface
    fun getScreenEventLog(): String {
      return synchronized(screenEvents) { screenEvents.joinToString("\n") }
    }

    // 熄屏投屏中断的常见主因是系统省电限制后台网络（小米/HyperOS 尤其激进），
    // 前台服务也可能被限速。检查是否已豁免电池优化。
    @JavascriptInterface
    fun isIgnoringBatteryOptimizations(): Boolean {
      return try {
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        pm.isIgnoringBatteryOptimizations(packageName)
      } catch (e: Exception) {
        true // 查询失败时视为已豁免，避免反复打扰
      }
    }

    // 弹出系统「允许后台运行」对话框（需清单声明 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）；
    // 厂商系统不支持直弹时退回电池优化设置列表页。
    @JavascriptInterface
    fun requestIgnoreBatteryOptimization() {
      runOnUiThread {
        try {
          val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
          intent.data = android.net.Uri.parse("package:$packageName")
          startActivity(intent)
        } catch (e: Exception) {
          try {
            startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
          } catch (e2: Exception) { /* 都打不开就静默 */ }
        }
      }
    }

    @JavascriptInterface
    fun setFullscreen(enabled: Boolean, landscape: Boolean) {
      runOnUiThread { applyFullscreen(enabled, landscape) }
    }

    @JavascriptInterface
    fun setKeepScreenOn(enabled: Boolean) {
      runOnUiThread {
        if (enabled) {
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }

    // 投屏期间保活：本地代理/本地媒体源在 App 进程里，电视持续从手机拉流。
    // 通过前台服务（CastKeepAliveService）把进程提升为前台优先级 + 持 WakeLock/WifiLock +
    // 常驻通知，规避 Doze 网络限制与 LMK 回收，使锁屏/后台投屏不中断。
    // 锁与通知的所有权已移入 Service，这里只负责启停。
    @JavascriptInterface
    fun keepAwake(enabled: Boolean) {
      try {
        // 注意：PlayerBridge 是 MainActivity 的 inner class，此处的 this 指向
        // PlayerBridge 实例本身（不是 Context），构造 Intent 必须显式用
        // this@MainActivity，否则匹配不到 Intent(Context, Class) 构造函数。
        val intent = Intent(this@MainActivity, CastKeepAliveService::class.java)
        if (enabled) {
          requestNotificationPermission()
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
          } else {
            @Suppress("DEPRECATION")
            startService(intent)
          }
        } else {
          stopService(intent)
        }
      } catch (e: Exception) {
        // 启动失败等场景静默处理：投屏可能因省电中断，但不崩溃
      }
    }

    // 应用窗口亮度，不影响系统设置，退出应用后自动恢复
    @JavascriptInterface
    fun setBrightness(value: Double) {
      val level = value.coerceIn(0.0, 1.0).toFloat()
      runOnUiThread {
        if (originalBrightness.isNaN()) originalBrightness = window.attributes.screenBrightness
        window.attributes = window.attributes.apply {
          screenBrightness = level
        }
      }
    }

    // 读取当前屏幕亮度，用于进入播放页时按系统值初始化
    @JavascriptInterface
    fun getBrightness(): Double {
      return try {
        val current = window.attributes.screenBrightness
        if (current >= 0f) {
          current.toDouble()
        } else {
          // 尚未覆盖时返回系统亮度
          android.provider.Settings.System.getInt(
            contentResolver,
            android.provider.Settings.System.SCREEN_BRIGHTNESS,
            255
          ) / 255.0
        }
      } catch (e: Exception) {
        1.0
      }
    }

    @JavascriptInterface
    fun getVolume(): Int {
      return try {
        val manager = getSystemService(AUDIO_SERVICE) as AudioManager
        val current = manager.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (max <= 0) 100 else Math.round(current * 100f / max)
      } catch (e: Exception) {
        100
      }
    }

    // 系统媒体音量，0-100
    @JavascriptInterface
    fun setVolume(percent: Int) {
      val clamped = percent.coerceIn(0, 100)
      runOnUiThread {
        try {
          val manager = getSystemService(AUDIO_SERVICE) as AudioManager
          if (originalVolume < 0) originalVolume = manager.getStreamVolume(AudioManager.STREAM_MUSIC)
          val max = manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
          val target = Math.round(max * clamped / 100f)
          manager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        } catch (e: SecurityException) {
          // 部分设备在勿扰模式等情况下受限，静默忽略
        }
      }
    }

    // 离开播放页时把音量和亮度还原成进入前的样子
    @JavascriptInterface
    fun restoreAudioBrightness() {
      runOnUiThread {
        try {
          if (originalVolume >= 0) {
            val manager = getSystemService(AUDIO_SERVICE) as AudioManager
            manager.setStreamVolume(AudioManager.STREAM_MUSIC, originalVolume, 0)
            originalVolume = -1
          }
        } catch (e: Exception) { /* ignore */ }
        if (!originalBrightness.isNaN()) {
          window.attributes = window.attributes.apply {
            screenBrightness = originalBrightness
          }
          originalBrightness = Float.NaN
        }
      }
    }
  }
}
