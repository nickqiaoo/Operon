package com.operon.app.shell

import android.content.Context
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import androidx.core.widget.NestedScrollView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.operon.app.R
import com.operon.app.shell.SheetUi.color
import com.operon.app.shell.SheetUi.dp

/**
 * The model picker (ios/App/App/ModelSheet.swift): a search field, then one
 * card per provider group — the group's logo and name as the card's first row,
 * its models below, the selected one checked.
 *
 * Filtering happens here rather than over the bridge: the full list arrives
 * once with the sheet, and typing must not cost a round trip through JS.
 */
object ModelSheet {

    data class Model(val id: String, val label: String, val group: String, val logo: String?)

    fun present(
        context: Context,
        title: String,
        searchPlaceholder: String,
        emptyText: String,
        models: List<Model>,
        selectedId: String?,
        onPick: (String) -> Unit,
        onDismiss: () -> Unit,
    ): BottomSheetDialog {
        var dialog: BottomSheetDialog? = null

        val results = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

        fun render(query: String) {
            results.removeAllViews()
            val groups = groupsFor(models, query)
            if (groups.isEmpty()) {
                results.addView(SheetUi.emptyText(context, emptyText))
                return
            }
            groups.forEachIndexed { index, group ->
                if (index > 0) results.addView(SheetUi.spacer(context))
                results.addView(
                    groupCard(context, group, selectedId) { id ->
                        onPick(id)
                        dialog?.dismiss()
                    },
                    SheetUi.matchWidth(),
                )
            }
        }

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(context.dp(16), context.dp(4), context.dp(16), context.dp(16))
            addView(SheetUi.title(context, title), SheetUi.matchWidth())
            addView(searchField(context, searchPlaceholder) { render(it) }, SheetUi.matchWidth())
            addView(SheetUi.spacer(context))
            addView(results, SheetUi.matchWidth())
        }

        render("")

        val body = NestedScrollView(context).apply {
            isFillViewport = true
            addView(
                column,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
        }

        return SheetUi.present(context, body, onDismiss).also { dialog = it }
    }

    private data class Group(val name: String, val logo: String?, val items: List<Model>)

    /** Groups in first-seen order, like the web panel's reduce over the list. */
    private fun groupsFor(models: List<Model>, query: String): List<Group> {
        val q = query.trim().lowercase()
        val filtered = if (q.isEmpty()) {
            models
        } else {
            models.filter { it.label.lowercase().contains(q) || it.id.lowercase().contains(q) }
        }
        val order = LinkedHashMap<String, MutableList<Model>>()
        filtered.forEach { order.getOrPut(it.group) { mutableListOf() }.add(it) }
        return order.map { (name, items) -> Group(name, items.firstOrNull()?.logo, items) }
    }

    private fun searchField(context: Context, placeholder: String, onQuery: (String) -> Unit): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dp(12), context.dp(2), context.dp(12), context.dp(2))
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = context.dp(10).toFloat()
                setColor(context.color(R.attr.operonTile))
            }
            addView(SheetUi.icon(context, R.drawable.ic_search, 16, R.attr.operonMutedForeground))
            addView(
                EditText(context).apply {
                    hint = placeholder
                    setHintTextColor(context.color(R.attr.operonMutedForeground))
                    setTextColor(context.color(R.attr.operonForeground))
                    setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15f)
                    background = null
                    maxLines = 1
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                        weight = 1f
                        marginStart = context.dp(8)
                    }
                    addTextChangedListener(object : TextWatcher {
                        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                        override fun afterTextChanged(s: Editable?) = onQuery(s?.toString().orEmpty())
                    })
                },
            )
        }

    private fun groupCard(
        context: Context,
        group: Group,
        selectedId: String?,
        onPick: (String) -> Unit,
    ): LinearLayout = SheetUi.card(context) {
        // The group header is a label, not a target: picking a provider is not
        // a thing the user can do here.
        addView(
            SheetUi.row(context) {
                addView(SheetUi.logoTile(context, group.logo))
                addView(
                    SheetUi.label(context, group.name, bold = true).apply {
                        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                            weight = 1f
                            marginStart = context.dp(12)
                        }
                    },
                )
            },
            SheetUi.matchWidth(),
        )

        group.items.forEach { model ->
            val active = model.id == selectedId
            addView(SheetUi.divider(context))
            addView(
                SheetUi.row(context, onClick = { onPick(model.id) }) {
                    setPadding(context.dp(54), context.dp(11), context.dp(14), context.dp(11))
                    addView(
                        SheetUi.label(
                            context,
                            model.label,
                            colorId = if (active) R.attr.operonForeground else R.attr.operonMutedForeground,
                        ).apply {
                            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT)
                                .apply { weight = 1f }
                        },
                    )
                    if (active) {
                        addView(SheetUi.icon(context, R.drawable.ic_check, 16, R.attr.operonBrand))
                    }
                },
                SheetUi.matchWidth(),
            )
        }
    }
}
