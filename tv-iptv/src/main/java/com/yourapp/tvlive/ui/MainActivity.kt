package com.yourapp.tvlive.ui

import android.os.Bundle
import android.view.KeyEvent
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.yourapp.tvlive.R
import com.yourapp.tvlive.auth.AuthManager
import com.yourapp.tvlive.data.ChannelRepository
import com.yourapp.tvlive.data.EpgRepository
import com.yourapp.tvlive.model.Channel
import com.yourapp.tvlive.net.ControlServer
import com.yourapp.tvlive.player.VideoPlayer
import com.yourapp.tvlive.storage.ConfigStore

/**
 * 主界面（电视端）。
 * 职责：
 *   1) 设备激活（自有账号体系）
 *   2) 从自有后端加载频道列表（失败回退本地），加载默认/上次频道
 *   3) 渲染频道列表，点击或遥控器数字键切台
 *   4) 显示当前频道 EPG（正在播出 / 接下来）
 *   5) 收藏当前频道（F 键 / 按钮），可按「仅看收藏」筛选（P 键 / 按钮）
 *   6) 启动自有本地控制服务（端口 9910）
 *   7) 退出时释放资源
 */
class MainActivity : AppCompatActivity() {

    private lateinit var player: VideoPlayer          // 播放器封装
    private lateinit var control: ControlServer       // 本地控制服务
    private lateinit var auth: AuthManager            // 自有认证
    private lateinit var adapter: ChannelAdapter      // 频道列表适配器
    private var channels = listOf<Channel>()          // 当前完整频道列表
    private var current: Channel? = null              // 正在播放的频道
    private var favOnly = false                        // 是否仅看收藏

    private val numBuffer = StringBuilder()           // 遥控器数字键缓冲
    private var numberBoard: NumberBoardDialog? = null // 数字键盘弹窗

    // UI 引用
    private lateinit var recycler: RecyclerView
    private lateinit var tvEpgTitle: TextView
    private lateinit var tvEpgNow: TextView
    private lateinit var tvEpgNext: TextView
    private lateinit var btnFav: Button
    private lateinit var btnFilter: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // 1) 设备激活（首次运行自动激活；生产环境替换为真实后端）
        auth = AuthManager(this)
        if (!auth.isActivated()) auth.activateDevice()

        // 2) 播放器：绑定 PlayerView
        player = VideoPlayer(this)
        val playerView = findViewById<PlayerView>(R.id.player_view)
        playerView.player = player.exoPlayer

        // UI 引用
        recycler = findViewById(R.id.recycler_channels)
        recycler.layoutManager = LinearLayoutManager(this)
        tvEpgTitle = findViewById(R.id.tv_epg_title)
        tvEpgNow = findViewById(R.id.tv_epg_now)
        tvEpgNext = findViewById(R.id.tv_epg_next)
        btnFav = findViewById(R.id.btn_fav)
        btnFilter = findViewById(R.id.btn_filter)

        // 4) 自有本地控制服务（端口 9910）
        control = ControlServer(9910)
        control.start()

        // 5) 加载频道（先试后端，失败回退本地）
        loadChannelsAsync()

        // 收藏 / 筛选按钮
        btnFav.setOnClickListener { current?.let { toggleFav(it) } }
        btnFilter.setOnClickListener { toggleFavFilter() }
    }

    /** 从后端加载频道（后台线程，避免主线程网络） */
    private fun loadChannelsAsync() {
        Thread {
            val remote = ChannelRepository.loadFromBackend(ConfigStore.getBackendUrl())
            val list = remote ?: ChannelRepository.loadChannels()
            runOnUiThread {
                channels = list
                refreshList()
                // 恢复上次观看的频道
                val last = ConfigStore.getLastChannel()
                channels.firstOrNull { it.id == last }?.let { playChannel(it) }
            }
        }.start()
    }

    /** 按当前筛选条件刷新列表 */
    private fun refreshList() {
        val shown = if (favOnly) channels.filter { ConfigStore.isFavorite(it.id) } else channels
        adapter = ChannelAdapter(
            items = shown,
            isFav = { ConfigStore.isFavorite(it.id) },
            onFav = { toggleFav(it) },
            onClick = { playChannel(it) }
        )
        recycler.adapter = adapter
    }

    /** 播放指定频道，并记录为「上次频道」 */
    private fun playChannel(ch: Channel) {
        current = ch
        player.play(ch.url)
        ConfigStore.setLastChannel(ch.id)
        title = ch.name
        updateFavButton()
        loadEpg(ch)
    }

    /** 拉取并显示当前频道 EPG */
    private fun loadEpg(ch: Channel) {
        Thread {
            val progs = EpgRepository.loadEpg(ConfigStore.getBackendUrl(), ch.id)
            runOnUiThread {
                val now = System.currentTimeMillis()
                val cur = progs.firstOrNull { now >= it.start && now < it.end }
                val nxt = progs.firstOrNull { it.start > now }
                tvEpgTitle.text = ch.name
                tvEpgNow.text = "正在播出：${cur?.title ?: "—"}"
                tvEpgNext.text = "接下来：${nxt?.title ?: "—"}"
            }
        }.start()
    }

    /** 切换收藏状态并刷新 UI */
    private fun toggleFav(ch: Channel) {
        ConfigStore.toggleFavorite(ch.id)
        updateFavButton()
        refreshList()
    }

    private fun updateFavButton() {
        val f = current?.let { ConfigStore.isFavorite(it.id) } ?: false
        btnFav.text = if (f) "★ 已收藏" else "☆ 收藏当前频道"
    }

    private fun toggleFavFilter() {
        favOnly = !favOnly
        btnFilter.text = if (favOnly) "显示全部" else "仅看收藏"
        refreshList()
    }

    /** 遥控器数字键切台：输入数字 -> 弹数字键盘 -> 按确定切台 */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // 把数字按键映射成字符
        val digit = when (keyCode) {
            KeyEvent.KEYCODE_0 -> '0'
            KeyEvent.KEYCODE_1 -> '1'
            KeyEvent.KEYCODE_2 -> '2'
            KeyEvent.KEYCODE_3 -> '3'
            KeyEvent.KEYCODE_4 -> '4'
            KeyEvent.KEYCODE_5 -> '5'
            KeyEvent.KEYCODE_6 -> '6'
            KeyEvent.KEYCODE_7 -> '7'
            KeyEvent.KEYCODE_8 -> '8'
            KeyEvent.KEYCODE_9 -> '9'
            else -> null
        }
        if (digit != null) {
            if (numBuffer.length < 4) numBuffer.append(digit)  // 最多 4 位
            showNumberBoard()
            return true
        }
        // 确定键：用当前缓冲数字切台
        if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            val n = numBuffer.toString().toIntOrNull()
            numBuffer.clear()
            if (n != null) {
                ChannelRepository.findByNumber(n, channels)?.let { playChannel(it) }
                numberBoard?.dismiss()
            }
            return true
        }
        // F 键：收藏/取消收藏当前频道
        if (keyCode == KeyEvent.KEYCODE_F) {
            current?.let { toggleFav(it) }
            return true
        }
        // P 键：切换「仅看收藏」筛选
        if (keyCode == KeyEvent.KEYCODE_P) {
            toggleFavFilter()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /** 显示/刷新数字键盘弹窗 */
    private fun showNumberBoard() {
        if (numberBoard == null) {
            numberBoard = NumberBoardDialog(this) { num ->
                ChannelRepository.findByNumber(num, channels)?.let { playChannel(it) }
                numBuffer.clear()
            }
        }
        numberBoard?.show()
    }

    /** 退出：释放播放器与控制服务 */
    override fun onDestroy() {
        super.onDestroy()
        control.stop()
        player.release()
    }
}
