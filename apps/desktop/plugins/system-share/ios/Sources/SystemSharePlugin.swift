import SwiftRs
import Tauri
import UIKit

private class ShareArgs: Decodable {
    let fileName: String
    let mimeType: String
    let contents: String
    let title: String
}

private func topViewController(_ root: UIViewController?) -> UIViewController? {
    if let presented = root?.presentedViewController {
        return topViewController(presented)
    }
    if let navigation = root as? UINavigationController {
        return topViewController(navigation.visibleViewController)
    }
    if let tabs = root as? UITabBarController {
        return topViewController(tabs.selectedViewController)
    }
    return root
}

private class SystemSharePlugin: Plugin {
    @objc public func share(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ShareArgs.self)
        let cleanName = (args.fileName as NSString).lastPathComponent
        guard cleanName == args.fileName, !cleanName.isEmpty else {
            invoke.reject("分享文件名无效")
            return
        }

        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("zichan-system-share", isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: nil
            )
            let staleBefore = Date().addingTimeInterval(-24 * 60 * 60)
            for file in try FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil
            ) where file.lastPathComponent != cleanName {
                let modified = try? file.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ).contentModificationDate
                if (modified ?? Date.distantPast) < staleBefore {
                    try? FileManager.default.removeItem(at: file)
                }
            }
            let target = directory.appendingPathComponent(cleanName, isDirectory: false)
            try Data(args.contents.utf8).write(to: target, options: .atomic)

            DispatchQueue.main.async {
                let windows = UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .flatMap { $0.windows }
                guard let controller = topViewController(
                    windows.first(where: { $0.isKeyWindow })?.rootViewController
                ) else {
                    invoke.reject("找不到可显示系统分享面板的窗口")
                    return
                }
                let activity = UIActivityViewController(
                    activityItems: [target],
                    applicationActivities: nil
                )
                activity.setValue(args.title, forKey: "subject")
                if let popover = activity.popoverPresentationController {
                    popover.sourceView = controller.view
                    popover.sourceRect = CGRect(
                        x: controller.view.bounds.midX,
                        y: controller.view.bounds.midY,
                        width: 1,
                        height: 1
                    )
                    popover.permittedArrowDirections = []
                }
                controller.present(activity, animated: true) {
                    invoke.resolve(["shared": true])
                }
            }
        } catch {
            invoke.reject("准备分享文件失败：\(error.localizedDescription)")
        }
    }
}

@_cdecl("init_plugin_system_share")
func initPlugin() -> Plugin {
    return SystemSharePlugin()
}
