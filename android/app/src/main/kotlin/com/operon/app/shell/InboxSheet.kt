package com.operon.app.shell

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.operon.app.R
import com.operon.app.shell.SheetUi.color
import com.operon.app.shell.SheetUi.dp

/**
 * The notification inbox (ios/App/App/InboxSheet.swift).
 *
 * Unlike the other sheets this one is live: JS pushes a fresh [State] on every
 * store change while it is up (`updateInboxSheet`), and every control here is
 * a plain intent sent back (`inboxAction`) — the store stays the single owner
 * of the data, exactly as on iOS and in the web panel.
 */
object InboxSheet {

    data class Item(
        val id: Int,
        val title: String,
        val body: String?,
        /** Already relative ("3m", "2d"), formatted by JS. */
        val time: String,
        /** Notification kind, named as an SF Symbol by the shared JS table. */
        val symbol: String,
        val action: Boolean,
        val unread: Boolean,
    )

    data class State(
        val filter: String,
        val items: List<Item>,
        val loading: Boolean,
        val loadingMore: Boolean,
        val hasMore: Boolean,
        val unreadCount: Int,
    )

    data class Labels(
        val title: String,
        val filters: List<Pair<String, String>>,
        val markAllRead: String,
        val empty: String,
        val loading: String,
        val loadMore: String,
    )

    /**
     * The symbol names come from `INBOX_KIND_SYMBOL` in
     * src/components/inbox/InboxItem.tsx, which is written in SF Symbols for
     * the iOS sheet. Rather than fork that table per platform, Android maps
     * the same names onto its own icons here — one table to keep in step
     * instead of two to keep in sync.
     */
    private fun iconFor(symbol: String): Int = when (symbol) {
        "exclamationmark.circle" -> R.drawable.ic_circle_alert
        "eye" -> R.drawable.ic_eye
        "checkmark.circle" -> R.drawable.ic_circle_check
        "xmark.circle" -> R.drawable.ic_circle_x
        "checkmark.shield" -> R.drawable.ic_shield_check
        "clock" -> R.drawable.ic_clock
        else -> R.drawable.ic_message_square
    }

    /**
     * Live handle on a presented sheet: [update] pushes a new snapshot,
     * [dismiss] closes it.
     */
    class Controller(
        private val context: Context,
        private val labels: Labels,
        private val onAction: (String, String?) -> Unit,
    ) {
        private var dialog: BottomSheetDialog? = null
        private var state: State? = null

        private lateinit var markAllRead: MaterialButton
        private lateinit var filters: MaterialButtonToggleGroup
        private lateinit var list: RecyclerView
        private lateinit var placeholder: TextView
        private lateinit var footer: LinearLayout
        private lateinit var footerButton: MaterialButton
        private lateinit var footerSpinner: ProgressBar
        private val adapter = Adapter()
        /** Set while the filter buttons are being synced, so echoing back is not a user action. */
        private var applyingFilter = false
        /** Generated view ids for the filter buttons, parallel to `labels.filters`. */
        private val filterButtonIds = labels.filters.map { View.generateViewId() }

        fun present(state: State, onDismiss: () -> Unit): BottomSheetDialog {
            this.state = state
            val body = buildBody()
            val dialog = SheetUi.present(context, body, onDismiss, fullHeight = true)
            this.dialog = dialog
            update(state)
            return dialog
        }

        fun update(state: State) {
            this.state = state
            markAllRead.isEnabled = state.unreadCount > 0

            applyingFilter = true
            labels.filters.forEachIndexed { index, (id, _) ->
                if (id == state.filter) filters.check(filterButtonIds[index])
            }
            applyingFilter = false

            val empty = state.items.isEmpty()
            when {
                state.loading && empty -> {
                    placeholder.text = labels.loading
                    placeholder.visibility = View.VISIBLE
                    list.visibility = View.GONE
                }
                empty && !state.hasMore -> {
                    placeholder.text = labels.empty
                    placeholder.visibility = View.VISIBLE
                    list.visibility = View.GONE
                }
                else -> {
                    placeholder.visibility = View.GONE
                    list.visibility = View.VISIBLE
                    adapter.submit(state.items)
                }
            }

            footer.visibility = if (state.hasMore && !empty) View.VISIBLE else View.GONE
            footerButton.visibility = if (state.loadingMore) View.GONE else View.VISIBLE
            footerSpinner.visibility = if (state.loadingMore) View.VISIBLE else View.GONE
        }

        fun dismiss() {
            dialog?.dismiss()
            dialog = null
        }

        private fun buildBody(): View = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )

            addView(header(), SheetUi.matchWidth())
            addView(filterRow(), SheetUi.matchWidth())

            placeholder = TextView(context).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                setTextColor(context.color(R.attr.operonMutedForeground))
                gravity = Gravity.CENTER
            }
            addView(
                placeholder,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0).apply { weight = 1f },
            )

            list = RecyclerView(context).apply {
                layoutManager = LinearLayoutManager(context)
                adapter = this@Controller.adapter
                setPadding(context.dp(16), context.dp(4), context.dp(16), context.dp(4))
                clipToPadding = false
            }
            attachSwipeToArchive(list)
            addView(
                list,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0).apply { weight = 1f },
            )

            addView(buildFooter(), SheetUi.matchWidth())
        }

        private fun header(): View = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dp(20), context.dp(4), context.dp(12), context.dp(8))

            addView(
                SheetUi.title(context, labels.title).apply {
                    setPadding(0, 0, 0, 0)
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT)
                        .apply { weight = 1f }
                },
            )

            markAllRead = MaterialButton(
                context,
                null,
                com.google.android.material.R.attr.materialButtonOutlinedStyle,
            ).apply {
                text = labels.markAllRead
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                icon = androidx.core.content.ContextCompat.getDrawable(context, R.drawable.ic_check_check)
                iconSize = context.dp(14)
                iconTint = ColorStateList.valueOf(context.color(R.attr.operonBrand))
                setTextColor(context.color(R.attr.operonBrand))
                strokeColor = ColorStateList.valueOf(context.color(R.attr.operonDivider))
                setOnClickListener { onAction("markAllRead", null) }
            }
            addView(markAllRead)
        }

        /**
         * Material's segmented button group is the counterpart of the iOS
         * segmented picker: same single-choice role, native look on each side.
         */
        private fun filterRow(): View {
            filters = MaterialButtonToggleGroup(context).apply {
                isSingleSelection = true
                isSelectionRequired = true
                setPadding(context.dp(16), 0, context.dp(16), context.dp(8))
            }
            labels.filters.forEachIndexed { index, (_, label) ->
                val button = MaterialButton(
                    context,
                    null,
                    com.google.android.material.R.attr.materialButtonOutlinedStyle,
                ).apply {
                    id = filterButtonIds[index]
                    text = label
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setTextColor(context.color(R.attr.operonForeground))
                    strokeColor = ColorStateList.valueOf(context.color(R.attr.operonDivider))
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT)
                        .apply { weight = 1f }
                }
                filters.addView(button)
            }
            filters.addOnButtonCheckedListener { _, checkedId, isChecked ->
                if (!isChecked || applyingFilter) return@addOnButtonCheckedListener
                val index = filterButtonIds.indexOf(checkedId)
                labels.filters.getOrNull(index)?.let { onAction("filter", it.first) }
            }
            return filters
        }

        private fun buildFooter(): View {
            footerButton = MaterialButton(
                context,
                null,
                com.google.android.material.R.attr.borderlessButtonStyle,
            ).apply {
                text = labels.loadMore
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setTextColor(context.color(R.attr.operonBrand))
                setOnClickListener { onAction("loadMore", null) }
            }
            footerSpinner = ProgressBar(context).apply {
                isIndeterminate = true
                indeterminateTintList = ColorStateList.valueOf(context.color(R.attr.operonBrand))
                layoutParams = LinearLayout.LayoutParams(context.dp(20), context.dp(20))
            }
            footer = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                setPadding(0, context.dp(4), 0, context.dp(8))
                addView(footerButton)
                addView(footerSpinner)
            }
            return footer
        }

        /**
         * Swipe a row away to archive it, the same gesture the iOS list offers
         * and the standard one for a dismissible list row on Android.
         */
        private fun attachSwipeToArchive(list: RecyclerView) {
            val callback = object : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.END) {
                override fun onMove(
                    recyclerView: RecyclerView,
                    viewHolder: RecyclerView.ViewHolder,
                    target: RecyclerView.ViewHolder,
                ): Boolean = false

                override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {
                    val item = adapter.itemAt(viewHolder.bindingAdapterPosition) ?: return
                    // The store removes the row and pushes a new snapshot; put
                    // the view back meanwhile so the list is never showing a
                    // gap that the data does not have.
                    adapter.notifyItemChanged(viewHolder.bindingAdapterPosition)
                    onAction("archive", item.id.toString())
                }
            }
            ItemTouchHelper(callback).attachToRecyclerView(list)
        }

        private inner class Adapter : RecyclerView.Adapter<RowHolder>() {
            private var items: List<Item> = emptyList()

            fun submit(next: List<Item>) {
                items = next
                notifyDataSetChanged()
            }

            fun itemAt(position: Int): Item? = items.getOrNull(position)

            override fun getItemCount() = items.size

            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = RowHolder(context)

            override fun onBindViewHolder(holder: RowHolder, position: Int) {
                val item = items[position]
                holder.bind(item) {
                    onAction("open", item.id.toString())
                }
                // Paging by arrival, like the SwiftUI list's onAppear: reaching
                // the last row asks for the next page.
                val state = this@Controller.state
                if (position == items.lastIndex && state?.hasMore == true && !state.loadingMore) {
                    onAction("loadMore", null)
                }
            }
        }
    }

    /** One notification row, built once and rebound as the list scrolls. */
    private class RowHolder(context: Context) : RecyclerView.ViewHolder(RowView(context)) {
        fun bind(item: Item, onClick: () -> Unit) = (itemView as RowView).bind(item, onClick)
    }

    private class RowView(context: Context) : LinearLayout(context) {
        private val icon = SheetUi.icon(context, R.drawable.ic_message_square, 18)
        private val dot = View(context)
        private val title = SheetUi.label(context, "", sizeSp = 14f)
        private val body = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(context.color(R.attr.operonMutedForeground))
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        private val time = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(context.color(R.attr.operonMutedForeground))
            typeface = Typeface.MONOSPACE
            maxLines = 1
        }

        init {
            orientation = HORIZONTAL
            gravity = Gravity.TOP
            setPadding(context.dp(14), context.dp(11), context.dp(14), context.dp(11))
            background = GradientDrawable().apply {
                cornerRadius = context.dp(12).toFloat()
                setColor(context.color(R.attr.operonCard))
            }
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
                .apply { topMargin = context.dp(6) }
            isClickable = true

            addView(icon.apply { layoutParams = LayoutParams(context.dp(18), context.dp(18)).apply { topMargin = context.dp(2) } })

            val column = LinearLayout(context).apply {
                orientation = VERTICAL
                layoutParams = LayoutParams(0, LayoutParams.WRAP_CONTENT).apply {
                    weight = 1f
                    marginStart = context.dp(12)
                }
            }
            val titleRow = LinearLayout(context).apply {
                orientation = HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(
                    dot.apply {
                        layoutParams = LayoutParams(context.dp(6), context.dp(6))
                            .apply { marginEnd = context.dp(6) }
                    },
                )
                addView(
                    title.apply {
                        layoutParams = LayoutParams(0, LayoutParams.WRAP_CONTENT).apply { weight = 1f }
                    },
                )
            }
            column.addView(titleRow, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            column.addView(body, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            addView(column)

            addView(
                time.apply {
                    layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                        marginStart = context.dp(8)
                        topMargin = context.dp(2)
                    }
                },
            )
        }

        fun bind(item: Item, onClick: () -> Unit) {
            val accent = if (item.action) R.attr.operonStatusWarn else R.attr.operonMutedForeground

            icon.setImageResource(iconFor(item.symbol))
            icon.imageTintList = ColorStateList.valueOf(context.color(accent))

            dot.visibility = if (item.unread) VISIBLE else GONE
            dot.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(
                    context.color(
                        if (item.action) R.attr.operonStatusWarn else R.attr.operonBrand,
                    ),
                )
            }

            title.text = item.title
            title.setTypeface(null, if (item.unread) Typeface.BOLD else Typeface.NORMAL)
            title.setTextColor(
                context.color(
                    if (item.unread) R.attr.operonForeground else R.attr.operonMutedForeground,
                ),
            )

            body.text = item.body.orEmpty()
            body.visibility = if (item.body.isNullOrEmpty()) GONE else VISIBLE

            time.text = item.time
            setOnClickListener { onClick() }
        }
    }
}
