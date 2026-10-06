package dev.shellbell.terminalinput

import android.content.Context
import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ShellbellTerminalInputModule : Module(), InputManager.InputDeviceListener {
  private var manager: InputManager? = null
  private var attached: Boolean? = null

  private fun inputManager(): InputManager =
    requireNotNull(appContext.reactContext).getSystemService(Context.INPUT_SERVICE) as InputManager

  private fun connected(): Boolean = InputDevice.getDeviceIds().any { id ->
    InputDevice.getDevice(id)?.let { device ->
      !device.isVirtual && device.supportsSource(InputDevice.SOURCE_KEYBOARD) &&
        device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    } ?: false
  }

  private fun publish() {
    val next = connected()
    if (attached != next) {
      attached = next
      sendEvent("keyboardChanged", mapOf("attached" to next))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ShellbellTerminalInput")
    Events("keyboardChanged")
    AsyncFunction("isKeyboardAttached") { connected() }
    OnStartObserving {
      manager = inputManager().also {
        it.registerInputDeviceListener(this@ShellbellTerminalInputModule, Handler(Looper.getMainLooper()))
      }
      publish()
    }
    OnStopObserving {
      manager?.unregisterInputDeviceListener(this@ShellbellTerminalInputModule)
      manager = null
      attached = null
    }
    OnDestroy {
      manager?.unregisterInputDeviceListener(this@ShellbellTerminalInputModule)
      manager = null
    }
  }

  override fun onInputDeviceAdded(deviceId: Int) = publish()
  override fun onInputDeviceRemoved(deviceId: Int) = publish()
  override fun onInputDeviceChanged(deviceId: Int) = publish()
}
