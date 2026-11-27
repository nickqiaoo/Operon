package com.operon.app.shell

import android.content.Context
import android.widget.LinearLayout
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.operon.app.shell.SheetUi.dp

/**
 * The "new chat" agent picker (ios/App/App/AgentSheet.swift): one card, one
 * row per agent with its provider logo. The pick comes back as `agentPicked`.
 */
object AgentSheet {

    data class Agent(val id: String, val label: String, val logo: String?, val enabled: Boolean)

    fun present(
        context: Context,
        title: String,
        emptyText: String,
        agents: List<Agent>,
        onPick: (String) -> Unit,
        onDismiss: () -> Unit,
    ): BottomSheetDialog {
        var dialog: BottomSheetDialog? = null

        val body = SheetUi.page(context) {
            addView(SheetUi.title(context, title), SheetUi.matchWidth())

            if (agents.isEmpty()) {
                addView(SheetUi.emptyText(context, emptyText))
            } else {
                addView(
                    SheetUi.card(context) {
                        agents.forEachIndexed { index, agent ->
                            if (index > 0) addView(SheetUi.divider(context))
                            val select: (() -> Unit)? = if (agent.enabled) {
                                {
                                    onPick(agent.id)
                                    dialog?.dismiss()
                                }
                            } else null
                            addView(
                                SheetUi.row(context, onClick = select) {
                                    addView(SheetUi.logoTile(context, agent.logo))
                                    addView(
                                        SheetUi.label(context, agent.label).apply {
                                            layoutParams = LinearLayout.LayoutParams(
                                                0,
                                                LinearLayout.LayoutParams.WRAP_CONTENT,
                                            ).apply {
                                                weight = 1f
                                                marginStart = context.dp(12)
                                            }
                                        },
                                    )
                                }.apply {
                                    isEnabled = agent.enabled
                                    alpha = if (agent.enabled) 1f else 0.45f
                                },
                                SheetUi.matchWidth(),
                            )
                        }
                    },
                    SheetUi.matchWidth(),
                )
            }
        }

        return SheetUi.present(context, body, onDismiss).also { dialog = it }
    }
}
