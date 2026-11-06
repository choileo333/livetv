package com.leo.tvlive.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.leo.tvlive.R
import com.leo.tvlive.data.Channel

/**
 * 频道列表适配器。
 *
 * @param items        当前要展示的频道（已按分组过滤后的结果）
 * @param isFav        判断某频道是否已收藏
 * @param onClick      点击某项切台，回传「列表内位置」与频道对象
 * @param onToggleFav  切换收藏
 * @param upFocusId    「按上方向键该去哪」的目标控件 id 提供者。
 *                     电视端需要它把列表与上方分组筛选条贯通：
 *                     分组按钮是运行时动态创建的，id 不固定，故用回调实时读取。
 */
class ChannelAdapter(
    private var items: List<Channel>,
    private val isFav: (Channel) -> Boolean,
    private val onClick: (Int, Channel) -> Unit,
    private val onToggleFav: (Channel) -> Unit,
    private val upFocusId: () -> Int = { View.NO_ID }
) : RecyclerView.Adapter<ChannelAdapter.VH>() {

    /** 单项视图持有者 */
    class VH(view: View) : RecyclerView.ViewHolder(view) {
        val index: TextView = view.findViewById(R.id.tv_index)   // 序号
        val name: TextView = view.findViewById(R.id.tv_name)     // 频道名
        val group: TextView = view.findViewById(R.id.tv_group)   // 分组名
        val star: TextView = view.findViewById(R.id.tv_star)     // 收藏星
    }

    /** 替换数据源并刷新（数据量小，直接全量刷新即可，逻辑更简单不易出错） */
    fun submit(list: List<Channel>) {
        items = list
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_channel, parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val ch = items[position]

        // 序号按「当前列表位置」显示（1 开始），与遥控器数字键直选一一对应
        holder.index.text = (position + 1).toString()
        holder.name.text = ch.name
        holder.group.text = ch.group
        holder.star.text = if (isFav(ch)) "★" else "☆"

        // 电视端：按「上」跳到分组筛选条（分组按钮不存在时退到「直播」标签）
        // 注意属性名是 nextFocusUpId（对应 View.setNextFocusUpId），不是 nextFocusUp
        val upId = upFocusId()
        if (upId != View.NO_ID) holder.itemView.nextFocusUpId = upId

        // 按「右」进入画面上的控制条（播放/静音/全屏）。
        // 不设这条连线的话，电视上从列表根本走不到控制条，「全屏」按钮就成了摆设。
        holder.itemView.nextFocusRightId = R.id.btn_ctrl_full

        // 点整行 = 切台
        holder.itemView.setOnClickListener { onClick(position, ch) }
        // 长按整行 = 收藏 / 取消收藏。
        // 电视端刻意用「长按」而不是「右方向键移到星标」：后者会让遥控器焦点掉进星标那一列，
        // 上下移动时只能沿着星标走，反而更难切台。
        holder.itemView.setOnLongClickListener {
            onToggleFav(ch)
            true   // 事件已消费，避免同时触发单击切台
        }
        // 星标仍支持鼠标/触摸点击（电视上不参与焦点导航，见 item_channel.xml 的说明）
        holder.star.setOnClickListener { onToggleFav(ch) }
    }

    override fun getItemCount(): Int = items.size
}
