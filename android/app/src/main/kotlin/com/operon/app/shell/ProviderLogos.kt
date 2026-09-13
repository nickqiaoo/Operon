package com.operon.app.shell

import com.operon.app.R

/**
 * Provider logo name → drawable.
 *
 * The names come from `providerLogoName` in
 * src/components/editor/components/ModelSelectorPanel.tsx and are the same
 * ones the iOS asset catalog uses, so all three clients are fed one
 * vocabulary. An unknown name is not an error — it draws a blank tile.
 */
object ProviderLogos {

    private val byName = mapOf(
        "antigravity" to R.drawable.ic_provider_antigravity,
        "claude" to R.drawable.ic_provider_claude,
        "copilot" to R.drawable.ic_provider_copilot,
        "cursor" to R.drawable.ic_provider_cursor,
        "custom" to R.drawable.ic_provider_custom,
        "deepseek" to R.drawable.ic_provider_deepseek,
        "google" to R.drawable.ic_provider_google,
        "grok" to R.drawable.ic_provider_grok,
        "kimi" to R.drawable.ic_provider_kimi,
        "minimax" to R.drawable.ic_provider_minimax,
        "openai" to R.drawable.ic_provider_openai,
        "opencode" to R.drawable.ic_provider_opencode,
        "openrouter" to R.drawable.ic_provider_openrouter,
        "vercel" to R.drawable.ic_provider_vercel,
        "zhipuai" to R.drawable.ic_provider_zhipuai,
    )

    fun drawableFor(name: String?): Int? = name?.let { byName[it] }

    /** True when the logo should take the text colour instead of its own. */
    fun isTemplate(name: String?): Boolean = name != "opencode"
}
