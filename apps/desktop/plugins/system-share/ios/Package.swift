// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-system-share",
    platforms: [.macOS(.v10_13), .iOS(.v13)],
    products: [
        .library(
            name: "tauri-plugin-system-share",
            type: .static,
            targets: ["tauri-plugin-system-share"]
        )
    ],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [
        .target(
            name: "tauri-plugin-system-share",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        )
    ]
)
