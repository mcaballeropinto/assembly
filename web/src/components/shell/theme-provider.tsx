import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ThemeProviderProps } from "next-themes"

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      {...props}
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="assembly-dashboard-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}
