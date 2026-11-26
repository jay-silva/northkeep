import ExpoModulesCore
import UserNotifications
import UIKit

/**
 * The number on the app icon (ADR 0095 section 8). Two calls, both local:
 * ask for the badge permission, and set or clear the badge. The permission
 * request names `.badge` only: no alert, no sound, and nothing here ever
 * schedules or posts a notification.
 */
public class AppBadgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppBadge")

    AsyncFunction("requestPermission") { (promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
          promise.resolve(settings.badgeSetting == .enabled)
        case .denied:
          promise.resolve(false)
        default:
          center.requestAuthorization(options: [.badge]) { granted, _ in
            promise.resolve(granted)
          }
        }
      }
    }

    AsyncFunction("setBadge") { (count: Int, promise: Promise) in
      let value = max(0, count)
      if #available(iOS 16.0, *) {
        UNUserNotificationCenter.current().setBadgeCount(value) { _ in
          promise.resolve(nil)
        }
      } else {
        DispatchQueue.main.async {
          UIApplication.shared.applicationIconBadgeNumber = value
          promise.resolve(nil)
        }
      }
    }
  }
}
