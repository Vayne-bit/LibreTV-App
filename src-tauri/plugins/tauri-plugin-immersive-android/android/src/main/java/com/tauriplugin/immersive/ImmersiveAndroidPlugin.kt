package com.tauriplugin.immersive // Package for the plugin's Kotlin code

import android.app.Activity
import android.os.Build
import android.view.View
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
// For a full plugin, you might extend app.tauri.plugin.Plugin
// import app.tauri.plugin.Plugin
// import app.tauri.plugin.Invoke
// import app.tauri.annotation.Command
// import app.tauri.annotation.TauriPlugin

// @TauriPlugin // Annotation if you were building a full, auto-registered plugin
// class ImmersiveAndroidPlugin: Plugin() { // Example if extending Plugin
class ImmersiveAndroidPlugin { // A simple class is enough if Rust calls static methods

    companion object {
        @JvmStatic // Crucial for JNI to find this static method from Rust
        @SuppressWarnings("deprecation") // For older Android system UI flags
        fun setImmersive(activity: Activity, enabled: Boolean) {
            // Ensure this runs on the UI thread, as UI manipulations must happen there
            activity.runOnUiThread {
                val window = activity.window
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
                    if (enabled) {
                        windowInsetsController.hide(WindowInsetsCompat.Type.systemBars())
                        windowInsetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    } else {
                        windowInsetsController.show(WindowInsetsCompat.Type.systemBars())
                    }
                } else {
                    var uiOptions = window.decorView.systemUiVisibility
                    if (enabled) {
                        uiOptions = uiOptions or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        uiOptions = uiOptions or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        uiOptions = uiOptions or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        uiOptions = uiOptions or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION // For navigation bar
                        uiOptions = uiOptions or View.SYSTEM_UI_FLAG_FULLSCREEN      // For status bar
                        uiOptions = uiOptions or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    } else {
                        // Clear the flags
                        uiOptions = uiOptions and View.SYSTEM_UI_FLAG_LAYOUT_STABLE.inv()
                        uiOptions = uiOptions and View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION.inv()
                        uiOptions = uiOptions and View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN.inv()
                        uiOptions = uiOptions and View.SYSTEM_UI_FLAG_HIDE_NAVIGATION.inv()
                        uiOptions = uiOptions and View.SYSTEM_UI_FLAG_FULLSCREEN.inv()
                        uiOptions = uiOptions and View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY.inv()
                    }
                    window.decorView.systemUiVisibility = uiOptions
                }
                println("Plugin Kotlin: Immersive mode set to " + enabled);
            }
        }
    }
}
