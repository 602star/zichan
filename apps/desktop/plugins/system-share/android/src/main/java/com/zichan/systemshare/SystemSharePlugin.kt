package com.zichan.systemshare

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.os.Build
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
    lateinit var fileName: String
    var mimeType: String = "application/octet-stream"
    lateinit var contents: String
    var title: String = "分享文件"
}

@InvokeArg
class InstallApkArgs {
    lateinit var path: String
}

@TauriPlugin
class SystemSharePlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun installApk(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallApkArgs::class.java)
            val allowed = File(activity.cacheDir, "zichan-updates").canonicalFile
            val target = File(args.path).canonicalFile
            if (target.parentFile != allowed || !target.name.endsWith(".apk") || !target.isFile || target.length() == 0L) {
                invoke.reject("APK 安装文件路径无效")
                return
            }
            if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
                activity.runOnUiThread {
                    try {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:${activity.packageName}")))
                        invoke.reject("请在打开的系统设置中允许安装更新包，然后返回应用重试")
                    } catch (error: Exception) {
                        invoke.reject(error.message ?: "无法打开安装权限设置")
                    }
                }
                return
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.zichan.systemshare.files", target)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(intent)
                    invoke.resolve(JSObject().apply { put("started", true) })
                } catch (error: Exception) { invoke.reject(error.message ?: "无法打开系统 APK 安装界面") }
            }
        } catch (error: Exception) { invoke.reject(error.message ?: "准备 APK 安装失败") }
    }

    @Command
    fun share(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareArgs::class.java)
            val cleanName = File(args.fileName).name
            if (cleanName != args.fileName || cleanName.isBlank()) {
                invoke.reject("分享文件名无效")
                return
            }

            val shareDirectory = File(activity.cacheDir, "zichan-system-share")
            if (!shareDirectory.exists() && !shareDirectory.mkdirs()) {
                invoke.reject("无法创建分享缓存目录")
                return
            }
            val staleBefore = System.currentTimeMillis() - 24L * 60L * 60L * 1000L
            shareDirectory.listFiles()
                ?.filter { it.name != cleanName && it.lastModified() < staleBefore }
                ?.forEach { it.delete() }
            val target = File(shareDirectory, cleanName)
            target.writeText(args.contents, Charsets.UTF_8)

            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.zichan.systemshare.files",
                target,
            )
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = args.mimeType.ifBlank { "application/octet-stream" }
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TITLE, args.title)
                clipData = ClipData.newRawUri(cleanName, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(intent, args.title).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(chooser)
                    invoke.resolve(JSObject().apply { put("shared", true) })
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "无法打开系统分享面板")
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "准备分享文件失败")
        }
    }
}
