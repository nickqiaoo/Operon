import { Keyboard } from "@capacitor/keyboard"

export function observeIosKeyboard(onChange: (height: number, visible: boolean) => void): () => void {
  void Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {})
  let active = true
  const listeners = [
    Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => {
      if (active) onChange(keyboardHeight, true)
    }),
    Keyboard.addListener("keyboardWillHide", () => {
      if (active) onChange(0, false)
    }),
  ]
  return () => {
    active = false
    for (const listener of listeners) void listener.then((handle) => handle.remove()).catch(() => {})
  }
}
