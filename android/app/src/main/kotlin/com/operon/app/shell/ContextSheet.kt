package com.operon.app.shell

import android.content.Context
import android.view.Gravity
import android.widget.LinearLayout
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.operon.app.R
import com.operon.app.shell.SheetUi.color
import com.operon.app.shell.SheetUi.dp

/**
 * The project → workspace picker (ios/App/App/ContextSheet.swift).
 *
 * One card per project: the project itself is the card's first row, with a
 * folder glyph on a brand-tinted tile, and its workspaces follow as indented
 * rows. The active workspace is the only row in full-strength text and carries
 * the brand check.
 *
 * Data arrives over `presentContextSheet`, the pick goes back as
 * `contextPicked`. See src/lib/native.ts.
 */
object ContextSheet {

    data class Workspace(val id: Int, val name: String)
    data class Project(val id: Int, val name: String, val workspaces: List<Workspace>)

    fun present(
        context: Context,
        title: String,
        emptyText: String,
        projects: List<Project>,
        activeProjectId: Int?,
        activeWorkspaceId: Int?,
        /** `(projectId, workspaceId)`; workspaceId is null for a project with none. */
        onPick: (Int, Int?) -> Unit,
        onDismiss: () -> Unit,
    ): BottomSheetDialog {
        var dialog: BottomSheetDialog? = null

        val body = SheetUi.page(context) {
            addView(SheetUi.title(context, title), SheetUi.matchWidth())

            if (projects.isEmpty()) {
                addView(SheetUi.emptyText(context, emptyText))
            } else {
                projects.forEachIndexed { index, project ->
                    if (index > 0) addView(SheetUi.spacer(context))
                    addView(
                        projectCard(context, project, activeProjectId, activeWorkspaceId) { p, w ->
                            onPick(p, w)
                            dialog?.dismiss()
                        },
                        SheetUi.matchWidth(),
                    )
                }
            }
        }

        return SheetUi.present(context, body, onDismiss).also { dialog = it }
    }

    private fun projectCard(
        context: Context,
        project: Project,
        activeProjectId: Int?,
        activeWorkspaceId: Int?,
        onPick: (Int, Int?) -> Unit,
    ): LinearLayout = SheetUi.card(context) {
        addView(
            SheetUi.row(context, onClick = { onPick(project.id, project.workspaces.firstOrNull()?.id) }) {
                addView(folderTile(context))
                addView(
                    SheetUi.label(context, project.name, bold = true).apply {
                        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                            weight = 1f
                            marginStart = context.dp(12)
                        }
                    },
                )
                // A project with workspaces is never itself the selection; the
                // check belongs to whichever workspace is active.
                if (project.workspaces.isEmpty() && project.id == activeProjectId) addView(check(context))
            },
            SheetUi.matchWidth(),
        )

        project.workspaces.forEach { workspace ->
            val active = workspace.id == activeWorkspaceId
            addView(SheetUi.divider(context))
            addView(
                SheetUi.row(context, onClick = { onPick(project.id, workspace.id) }) {
                    setPadding(context.dp(54), context.dp(11), context.dp(14), context.dp(11))
                    addView(
                        SheetUi.label(
                            context,
                            workspace.name,
                            colorId = if (active) R.attr.operonForeground else R.attr.operonMutedForeground,
                        ).apply {
                            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT)
                                .apply { weight = 1f }
                        },
                    )
                    if (active) addView(check(context))
                },
                SheetUi.matchWidth(),
            )
        }
    }

    private fun folderTile(context: Context) = android.widget.FrameLayout(context).apply {
        background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = context.dp(8).toFloat()
            // The brand at low alpha, as on iOS: enough to read as a tile
            // without turning the row into a coloured band.
            setColor(androidx.core.graphics.ColorUtils.setAlphaComponent(context.color(R.attr.operonBrand), 31))
        }
        layoutParams = LinearLayout.LayoutParams(context.dp(28), context.dp(28))
        addView(
            SheetUi.icon(context, R.drawable.ic_folder, 14, R.attr.operonBrand).apply {
                layoutParams = android.widget.FrameLayout.LayoutParams(
                    context.dp(14),
                    context.dp(14),
                    Gravity.CENTER,
                )
            },
        )
    }

    private fun check(context: Context) = SheetUi.icon(context, R.drawable.ic_check, 16, R.attr.operonBrand)
}
