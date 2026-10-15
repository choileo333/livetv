package com.yourapp.tvlive.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.yourapp.tvlive.R
import com.yourapp.tvlive.model.Channel

/**
 * 频道列表适配器（RecyclerView）。
 * 负责把 Channel 列表渲染成可遥控导航的项，并处理点击/选中高亮、收藏星标。
 */
class ChannelAdapter(
    private val items: List<Channel>,
    private val isFav: (Channel) -> Boolean,        // 该频道是否收藏
    private val onFav: (Channel) -> Unit,           // 点击星标切换收藏
    private val onClick: (Channel) -> Unit          // 点击频道切台
) : RecyclerView.Adapter<ChannelAdapter.VH>() {

    /** 单个频道项的视图持有者 */
    class VH(view: View) : RecyclerView.ViewHolder(view) {
        val name: TextView = view.findViewById(R.id.tv_channel_name)
        val star: TextView = view.findViewById(R.id.tv_fav_star)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_channel, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val ch = items[position]
        holder.name.text = "${ch.id}. ${ch.name}"          // 显示「编号. 名称」
        holder.star.text = if (isFav(ch)) "★" else ""        // 收藏显示星标
        holder.itemView.setOnClickListener { onClick(ch) }
        holder.star.setOnClickListener { onFav(ch) }

        // 遥控器方向键选中时高亮（电视端体验）
        holder.itemView.onFocusChangeListener = View.OnFocusChangeListener { v, hasFocus ->
            v.setBackgroundColor(if (hasFocus) 0x66FFFFFF.toInt() else 0)
        }
    }

    override fun getItemCount(): Int = items.size
}
