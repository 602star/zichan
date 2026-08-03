package com.zichan.systemshare

import android.app.Activity
import android.content.ClipData
import android.content.Intent
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

@TauriPlugin
class SystemSharePlugin(private val activity: Activity) : Plugin(activity) {
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
