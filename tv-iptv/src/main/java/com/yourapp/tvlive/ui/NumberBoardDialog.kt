package com.yourapp.tvlive.ui

import android.app.Dialog
import android.content.Context
import android.view.Gravity
import android.widget.Button
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 数字键盘对话框：电视遥控器输入频道号后切台。
 * 交互参考了原 App 的「数字键盘」体验，但完全自有实现（不依赖任何第三方 UI/SDK）。
 *
 * 用法：
 *   NumberBoardDialog(context) { channelNumber ->
 *       // 拿到用户输入的频道号，去做切台
 *   }.show()
 */
class NumberBoardDialog(
    context: Context,
    private val onConfirm: (Int) -> Unit
) : Dialog(context) {

    private val buffer = StringBuilder()   // 用户输入的数字缓冲
    private lateinit var input: TextView    // 顶部显示已输入的数字

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 顶部：显示当前输入
        input = TextView(context).apply {
            textSize = 34f
            gravity = Gravity.CENTER
            setText("")
            minHeight = 100
        }

        // 数字键盘：1-9、删除、0、确认
        val keys = listOf("1","2","3","4","5","6","7","8","9","删除","0","确认")
        val pad = GridLayout(context).apply {
            columnCount = 3
            setPadding(24, 24, 24, 24)
        }
        keys.forEach { label ->
            val btn = Button(context).apply {
                text = label
                textSize = 24f
                setOnClickListener { handleKey(label) }
            }
            pad.addView(btn, GridLayout.LayoutParams().apply {
                setMargins(8, 8, 8, 8)
            })
        }

        // 竖向根布局：输入区 + 键盘
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(input)
            addView(pad)
        }
        setContentView(root)
    }

    /** 处理某个按键 */
    private fun handleKey(label: String) {
        when (label) {
            "删除" -> if (buffer.isNotEmpty()) buffer.deleteCharAt(buffer.length - 1)
            "确认" -> {
                val num = buffer.toString().toIntOrNull()
                if (num != null) onConfirm(num)   // 回调频道号
                dismiss()
            }
            else -> if (buffer.length < 4) buffer.append(label)  // 最多 4 位
        }
        input.text = buffer.toString()
    }
}
