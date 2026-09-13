package com.operon.app.shell

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.operon.app.R
import com.operon.app.shell.SheetUi.color
import com.operon.app.shell.SheetUi.dp

/**
 * Read-only stats (ios/App/App/InfoSheet.swift) — the context-window
 * breakdown and the Claude subscription quotas both render through this.
 *
 * One card per section: an optional header line with a value and a progress
 * bar, then plain rows, then an optional footer. Values are monospaced because
 * they are numbers the user compares down a column.
 */
object InfoSheet {

    data class Row(
        val label: String,
        val value: String?,
        val detail: String?,
        /** `#rrggbb`, drawn as a swatch before the label. */
        val color: String?,
        val indent: Boolean,
    )

    enum class Tone {
        NORMAL, WARN, ERROR;

        companion object {
            fun from(raw: String?): Tone = when (raw) {
                "warn" -> WARN
                "error" -> ERROR
                else -> NORMAL
            }
        }
    }

    data class Section(
        val header: String?,
        val value: String?,
        /** 0…1 */
        val progress: Double?,
        val tone: Tone,
        val footer: String?,
        val rows: List<Row>,
    )

    fun present(
        context: Context,
        title: String,
        caption: String?,
        sections: List<Section>,
        onDismiss: () -> Unit,
    ): BottomSheetDialog {
        val body = SheetUi.page(context) {
            addView(
                SheetUi.title(context, title).apply {
                    if (caption != null) setPadding(context.dp(4), context.dp(4), context.dp(4), 0)
                },
                SheetUi.matchWidth(),
            )
            if (caption != null) {
                addView(
                    TextView(context).apply {
                        text = caption.uppercase()
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                        setTypeface(typeface, Typeface.BOLD)
                        setTextColor(context.color(R.attr.operonMutedForeground))
                        setPadding(context.dp(4), 0, context.dp(4), context.dp(12))
                    },
                    SheetUi.matchWidth(),
                )
            }

            sections.forEachIndexed { index, section ->
                if (index > 0) addView(SheetUi.spacer(context))
                addView(sectionCard(context, section), SheetUi.matchWidth())
            }
        }

        return SheetUi.present(context, body, onDismiss)
    }

    private fun sectionCard(context: Context, section: Section): LinearLayout = SheetUi.card(context) {
        setPadding(context.dp(14), context.dp(12), context.dp(14), context.dp(12))

        if (section.header != null || section.value != null) {
            addView(
                LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(
                        SheetUi.label(context, section.header.orEmpty(), sizeSp = 14f).apply {
                            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT)
                                .apply { weight = 1f }
                        },
                    )
                    section.value?.let {
                        addView(mono(context, it, toneColor(context, section.tone)))
                    }
                },
                SheetUi.matchWidth(),
            )
        }

        section.progress?.let { progress ->
            addView(
                LinearProgressIndicator(context).apply {
                    max = 1000
                    setProgressCompat((progress.coerceIn(0.0, 1.0) * 1000).toInt(), false)
                    trackCornerRadius = context.dp(3)
                    trackThickness = context.dp(6)
                    setIndicatorColor(barColor(context, section.tone))
                    trackColor = context.color(R.attr.operonTile)
                    layoutParams = SheetUi.matchWidth().apply { topMargin = context.dp(8) }
                },
            )
        }

        section.rows.forEachIndexed { index, row ->
            addView(
                rowView(context, row).apply {
                    layoutParams = SheetUi.matchWidth().apply {
                        topMargin = if (index == 0) context.dp(8) else context.dp(6)
                    }
                },
            )
        }

        section.footer?.let { footer ->
            addView(
                TextView(context).apply {
                    text = footer
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    setTextColor(context.color(R.attr.operonMutedForeground))
                    gravity = Gravity.END
                    layoutParams = SheetUi.matchWidth().apply { topMargin = context.dp(8) }
                },
            )
        }
    }

    private fun rowView(context: Context, row: Row): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL

        parseHex(row.color)?.let { swatch ->
            addView(
                android.view.View(context).apply {
                    background = GradientDrawable().apply {
                        cornerRadius = context.dp(2).toFloat()
                        setColor(swatch)
                    }
                    layoutParams = LinearLayout.LayoutParams(context.dp(8), context.dp(8))
                        .apply { marginEnd = context.dp(8) }
                },
            )
        }

        addView(
            SheetUi.label(context, row.label, sizeSp = 13f, colorId = R.attr.operonMutedForeground).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    weight = 1f
                    marginStart = if (row.indent) context.dp(12) else 0
                }
            },
        )

        row.value?.let {
            addView(
                mono(
                    context,
                    it,
                    context.color(if (row.indent) R.attr.operonMutedForeground else R.attr.operonForeground),
                ),
            )
        }
        row.detail?.let {
            addView(
                mono(context, it, context.color(R.attr.operonMutedForeground)).apply {
                    minWidth = context.dp(44)
                    gravity = Gravity.END
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { marginStart = context.dp(8) }
                },
            )
        }
    }

    private fun mono(context: Context, text: String, colour: Int): TextView = TextView(context).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        typeface = Typeface.MONOSPACE
        setTextColor(colour)
        maxLines = 1
    }

    private fun toneColor(context: Context, tone: Tone): Int = when (tone) {
        Tone.NORMAL -> context.color(R.attr.operonForeground)
        Tone.WARN -> context.color(R.attr.operonStatusWarn)
        Tone.ERROR -> context.color(R.attr.operonStatusError)
    }

    private fun barColor(context: Context, tone: Tone): Int = when (tone) {
        Tone.NORMAL -> context.color(R.attr.operonBrand)
        Tone.WARN -> context.color(R.attr.operonStatusWarn)
        Tone.ERROR -> context.color(R.attr.operonStatusError)
    }

    /** `#rrggbb` / `#rgb`; null for anything else (CSS variables, hsl()…). */
    private fun parseHex(value: String?): Int? {
        val raw = value?.trim()?.removePrefix("#") ?: return null
        val hex = when (raw.length) {
            3 -> raw.map { "$it$it" }.joinToString("")
            6 -> raw
            else -> return null
        }
        return try {
            Color.parseColor("#$hex")
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}
