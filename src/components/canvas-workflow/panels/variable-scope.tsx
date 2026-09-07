import { createContext, useContext } from "react"
import type { AvailableVariable } from "../hooks/useAvailableVariables"

/**
 * The variables the node being configured can reference. Provided once by
 * the config panel so every template field, however deep, can offer them.
 */
const VariableScopeContext = createContext<AvailableVariable[]>([])

export const VariableScopeProvider = VariableScopeContext.Provider

export function useVariableScope(): AvailableVariable[] {
  return useContext(VariableScopeContext)
}
