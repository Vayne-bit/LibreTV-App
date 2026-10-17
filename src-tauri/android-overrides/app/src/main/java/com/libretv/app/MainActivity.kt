package com.libretv.app

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  @Volatile
  private var playerFullscreen = false

  override fun onCreate(savedInstanceState: Bundle?) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    super.onCreate(savedInstanceState)

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

  inner class PlayerBridge {
    // 进入播放页时记录原始音量与亮度，退出时还原
    private var originalVolume = -1
    private var originalBrightness = Float.NaN

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
