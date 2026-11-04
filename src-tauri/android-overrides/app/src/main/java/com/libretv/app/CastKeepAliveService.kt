package com.libretv.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 投屏保活前台服务。
 *
 * 本地视频 / VIP 投屏时，媒体源就在 App 进程里（手机本地 HTTP 服务暴露给电视拉流），
 * 普通后台状态下 Android 会冻结网络、甚至回收进程，导致电视端卡断 / 中断。
 *
 * 此服务把 App 进程提升为「前台优先级」+ 持 PARTIAL_WAKE_LOCK（CPU 不睡）
 * + WIFI_MODE_FULL_HIGH_PERF（高性能 WiFi）+ 展示常驻通知，从而规避 Doze 网络限制与
 * LMK 回收，使「锁屏 / 后台」时投屏不中断。
 *
 * 用户主动退出 App（进程被杀）时，服务随进程消亡——这是预期行为。
 */
class CastKeepAliveService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        // 必须在 startForeground 之前确保 channel 已存在（Android 8+），否则崩溃。
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification())
        acquireLocks()
        // START_NOT_STICKY：进程被系统回收后不自动重启。
        // 投屏本就随进程消亡，不需要一个孤儿服务继续挂着通知。
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun acquireLocks() {
        // 防重入：已被同服务实例持有时直接返回，避免重复 newWakeLock 造成旧锁泄漏。
        if (wakeLock?.isHeld == true || wifiLock?.isHeld == true) return
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, "LibreTV:CastKeepAlive"
            ).apply {
                setReferenceCounted(false)
                acquire(2L * 60 * 60 * 1000) // 最长 2 小时兜底，防泄漏
            }
            val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wifi.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF, "LibreTV:CastWifi"
            ).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            // 权限缺失等场景静默失败：投屏可能因省电中断，但不崩溃。
        }
    }

    private fun releaseLocks() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
            wifiLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) { /* ignore */ }
        wakeLock = null
        wifiLock = null
    }

    private fun createNotificationChannel() {
        // 注意：无条件创建，不要根据 areNotificationsEnabled() 跳过。
        // 否则 Android 13 用户拒绝通知权限时 startForeground 会崩溃（参考 SO #73067939）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "投屏保活",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    setShowBadge(false)
                    setSound(null, null)
                    enableLights(false)
                    vibrationPattern = null
                }
                mgr.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pi = PendingIntent.getActivity(this, 0, launchIntent, flags)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("LibreTV 正在投屏")
            .setContentText("保持后台运行，避免电视端中断")
            .setSmallIcon(android.R.drawable.ic_media_play) // 占位图标，建议替换为 App 图标
            .setContentIntent(pi)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "libretv_cast_keepalive"
        const val NOTIF_ID = 1001
    }
}
