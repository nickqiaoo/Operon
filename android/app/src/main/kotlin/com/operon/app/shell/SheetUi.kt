package com.operon.app.shell

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.view.ContextThemeWrapper
import androidx.core.content.ContextCompat
import androidx.core.widget.NestedScrollView
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.operon.app.R

/**
 * Shared pieces for the native bottom sheets — the Android counterpart of the
 * `NativeSheet` enum and the SwiftUI card layout in ios/App/App/ContextSheet.swift.
 *
 * The visual language is carried over deliberately, so the two platforms read
 * as the same product: a quiet grey ground, one rounded card per group, rows
 * of a fixed height separated by a hairline that starts past the leading
 * glyph. What is *not* carried over is the presentation itself — this is a
 * Material modal bottom sheet, with its drag handle, its corner radius and its
 * dismissal behaviour, rather than an imitation of a UIKit sheet.
 */
object SheetUi {

    /** One card row: a label with its vertical padding. */
    const val ROW_HEIGHT_DP = 44

    /**
     * A context themed for the app's own light/dark setting rather than the
     * system's.
     *
     * Two themes rather than one theme plus an overridden night bit: an
     * activity-derived context whose configuration was overridden gets rebased
     * back onto the activity's own configuration as soon as anything touches
     * the window, and a sheet built that way came up with dark text on a light
     * ground. See attrs_operon.xml.
     */
    fun themed(activity: Activity, dark: Boolean, sheet: Boolean = true): Context {
        val theme = when {
            sheet && dark -> R.style.Theme_Operon_BottomSheet_Dark
            sheet -> R.style.Theme_Operon_BottomSheet
            dark -> R.style.Theme_Operon_Shell_Dark
            else -> R.style.Theme_Operon_Shell
        }
        return ContextThemeWrapper(activity, theme)
    }

    fun Context.dp(value: Number): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics,
        ).toInt()

    /** Resolve one of the `operon*` palette attributes against this context's theme. */
    fun Context.color(attr: Int): Int {
        val out = TypedValue()
        theme.resolveAttribute(attr, out, true)
        return if (out.resourceId != 0) ContextCompat.getColor(this, out.resourceId) else out.data
    }

    /**
     * Present [content] as a modal sheet.
     *
     * Opened expanded rather than at a peek height: every one of these sheets
     * is a short list the user came to act on, and a half-open sheet would
     * make them drag before they could.
     */
    fun present(
        context: Context,
        content: View,
        onDismiss: () -> Unit,
        fullHeight: Boolean = false,
    ): BottomSheetDialog {
        // The theme comes off the context, which the two sheet themes point
        // back at themselves (bottomSheetDialogTheme). Without that self
        // reference BottomSheetDialog finds no such attribute and silently
        // falls back to Theme.Design.Light.BottomSheetDialog.
        val dialog = BottomSheetDialog(context)
        val wrapper = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(context.color(R.attr.operonSheetGround))
            addView(
                com.google.android.material.bottomsheet.BottomSheetDragHandleView(context),
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
            addView(
                content,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    if (fullHeight) 0 else ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { if (fullHeight) weight = 1f },
            )
        }
        if (fullHeight) {
            wrapper.layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                (context.resources.displayMetrics.heightPixels * 0.85).toInt(),
            )
        }
        dialog.setContentView(wrapper)
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.behavior.skipCollapsed = true
        // The keyboard (for the model sheet's search field) is left to the
        // bottom sheet's own inset handling. `SOFT_INPUT_ADJUST_RESIZE` would
        // be the obvious lever and is deprecated from API 30, where it stops
        // resizing the window at all — so setting it would fix nothing on a
        // current device while adding a call that does something different on
        // an old one.
        dialog.setOnDismissListener { onDismiss() }
        dialog.show()
        return dialog
    }

    /** Scrollable page body with the sheets' shared padding. */
    fun page(context: Context, build: LinearLayout.() -> Unit): View {
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(context.dp(16), context.dp(4), context.dp(16), context.dp(16))
            build()
        }
        return NestedScrollView(context).apply {
            isFillViewport = true
            addView(
                column,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
        }
    }

    fun title(context: Context, text: String): TextView = TextView(context).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(context.color(R.attr.operonForeground))
        setPadding(context.dp(4), context.dp(4), context.dp(4), context.dp(12))
    }

    /** The rounded card every sheet groups its rows into. */
    fun card(context: Context, build: LinearLayout.() -> Unit): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = context.dp(14).toFloat()
                setColor(context.color(R.attr.operonCard))
            }
            clipToOutline = true
            build()
        }

    /** Vertical gap between cards, matching the SwiftUI stack spacing. */
    fun spacer(context: Context, height: Number = 12): View = View(context).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(height))
    }

    /** Hairline between rows, inset past the leading glyph like the iOS divider. */
    fun divider(context: Context, insetStartDp: Number = 54): View = View(context).apply {
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            context.dp(1).coerceAtLeast(1),
        ).apply { marginStart = context.dp(insetStartDp) }
        setBackgroundColor(context.color(R.attr.operonDivider))
    }

    /**
     * A tappable row. Ripple rather than the iOS quiet fill: press feedback is
     * the one place where copying the other platform would look wrong.
     */
    fun row(context: Context, onClick: (() -> Unit)? = null, build: LinearLayout.() -> Unit): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dp(14), context.dp(11), context.dp(14), context.dp(11))
            if (onClick != null) {
                isClickable = true
                background = RippleDrawable(
                    ColorStateList.valueOf(context.color(R.attr.operonRowPressed)),
                    null,
                    null,
                )
                setOnClickListener { onClick() }
            }
            build()
        }

    fun label(
        context: Context,
        text: String,
        sizeSp: Float = 16f,
        bold: Boolean = false,
        colorId: Int = R.attr.operonForeground,
    ): TextView = TextView(context).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setTextColor(context.color(colorId))
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
    }

    /** Pushes whatever follows to the trailing edge. */
    fun grow(context: Context): View = View(context).apply {
        layoutParams = LinearLayout.LayoutParams(0, 1).apply { weight = 1f }
    }

    fun icon(context: Context, drawable: Int, sizeDp: Number = 18, tintId: Int = R.attr.operonForeground): ImageView =
        ImageView(context).apply {
            setImageResource(drawable)
            imageTintList = ColorStateList.valueOf(context.color(tintId))
            layoutParams = LinearLayout.LayoutParams(context.dp(sizeDp), context.dp(sizeDp))
        }

    /**
     * A provider logo on a quiet tile; a blank tile when the name is unknown,
     * so rows stay aligned whether or not a logo exists.
     */
    fun logoTile(context: Context, logo: String?): View {
        val tile = FrameLayout(context).apply {
            background = GradientDrawable().apply {
                cornerRadius = context.dp(8).toFloat()
                setColor(context.color(R.attr.operonTile))
            }
            layoutParams = LinearLayout.LayoutParams(context.dp(28), context.dp(28))
        }
        val drawable = ProviderLogos.drawableFor(logo)
        if (drawable != null) {
            val image = ImageView(context).apply {
                setImageResource(drawable)
                // The two-tone opencode mark carries its own colours; every
                // other logo is a template glyph that takes the text colour.
                if (ProviderLogos.isTemplate(logo)) {
                    imageTintList = ColorStateList.valueOf(context.color(R.attr.operonForeground))
                }
                layoutParams = FrameLayout.LayoutParams(context.dp(18), context.dp(18), Gravity.CENTER)
            }
            tile.addView(image)
        }
        return tile
    }

    fun emptyText(context: Context, text: String): TextView = TextView(context).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setTextColor(context.color(R.attr.operonMutedForeground))
        gravity = Gravity.CENTER
        setPadding(0, context.dp(28), 0, context.dp(28))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    fun matchWidth(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    )
}
