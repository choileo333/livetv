package com.yourapp.tvlive.net

import android.util.Log
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 自有本地 HTTP 控制服务。
 * 用途：在电视盒上提供「本机指令/状态查询」通道（例如远程切台、进程信息查询）。
 * 端口和协议都由你自己定义（这里用 9910，避免与原 App 的 9906 混淆/冲突）。
 * 这是一个干净的回显/状态服务，不包含任何破解原 App 的逻辑。
 */
class ControlServer(private val port: Int = 9910) {

    private var serverSocket: ServerSocket? = null
    private val running = AtomicBoolean(false)   // 线程安全地标记服务是否在跑

    /** 启动本地服务（在独立后台线程监听） */
    fun start() {
        if (running.get()) return                // 已在运行则不重复启动
        running.set(true)
        Thread {
            try {
                serverSocket = ServerSocket(port)
                while (running.get()) {
                    val client = serverSocket!!.accept()   // 阻塞等待连接
                    // 简易实现：返回一段 JSON 状态（生产环境按你的协议扩展）
                    val body = """{"status":"ok","port":$port,"service":"tvlive"}"""
                    val resp = buildString {
                        append("HTTP/1.1 200 OK\r\n")
                        append("Content-Type: application/json\r\n")
                        append("Content-Length: ${body.toByteArray().size}\r\n")
                        append("\r\n")
                        append(body)
                    }
                    client.getOutputStream().write(resp.toByteArray())
                    client.getOutputStream().flush()
                    client.close()
                }
            } catch (e: IOException) {
                Log.e("ControlServer", "server error: ${e.message}")
            }
        }.start()
    }

    /** 停止服务并释放端口 */
    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: IOException) { /* 忽略关闭异常 */ }
    }
}
