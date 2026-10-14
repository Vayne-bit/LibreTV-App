use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};
use serde::Deserialize; // For command arguments

#[derive(Deserialize)]
struct ImmersiveModePayload {
    enabled: bool,
}

#[tauri::command]
// For Tauri 2.x, AppHandle in commands should be AppHandle<R> where R: Runtime
// The specific runtime (e.g., Wry) will be inferred from the context where the plugin is registered.
fn set_immersive_android<R: Runtime>(app_handle: AppHandle<R>, payload: ImmersiveModePayload) -> Result<(), String> {
    log::info!("Plugin: set_immersive_android called with enabled = {}", payload.enabled);
    #[cfg(target_os = "android")]
    {
        // Accessing Android specific APIs via AppHandle<R>
        // The methods like .android_main_thread_vm() and .get_android_activity()
        // are typically available if R is a runtime configured for Android (like tauri::Wry)
        // and the correct features are enabled on the tauri dependency.

        let vm = app_handle.android_main_thread_vm().map_err(|e| {
            log::error!("Failed to get Android VM: {:?}", e);
            e.to_string()
        })?;
        let env = vm.attach_current_thread().map_err(|e| {
            log::error!("Failed to attach JNI env: {:?}", e);
            e.to_string()
        })?;
        
        let plugin_class_path = "com/tauriplugin/immersive/ImmersiveAndroidPlugin";
        let plugin_class = env.find_class(plugin_class_path)
            .map_err(|e| {
                log::error!("Failed to find plugin class '{}': {:?}", plugin_class_path, e);
                format!("Failed to find plugin class '{}': {:?}", plugin_class_path, e)
            })?;

        let activity_obj = app_handle.get_android_activity()
            .ok_or_else(|| {
                log::error!("Failed to get Android activity instance from AppHandle.");
                "Failed to get Android activity instance".to_string()
            })?;
        
        // Call the static Kotlin method: `fun setImmersive(activity: Activity, enabled: Boolean)`
        // Method signature: (Landroid/app/Activity;Z)V
        match env.call_static_method(
            plugin_class,
            "setImmersive", // Name of the Kotlin static method
            "(Landroid/app/Activity;Z)V", // JNI signature
            &[activity_obj.as_obj().into(), payload.enabled.into()],
        ) {
            Ok(_) => {
                log::info!("Plugin: Successfully called Kotlin setImmersive method.");
                Ok(())
            }
            Err(e) => {
                log::error!("Plugin: Error calling Kotlin setImmersive method: {:?}", e);
                Err(format!("JNI call failed: {:?}", e))
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        log::info!("Plugin: set_immersive_android called on non-Android OS, no action taken.");
        Ok(())
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R, ()> { // Explicitly state S = ()
    Builder::<R, ()>::new("immersiveandroid") // The name of the plugin (used in JS: plugin:immersiveandroid|...)
        .invoke_handler(tauri::generate_handler![set_immersive_android])
        .build()
}
