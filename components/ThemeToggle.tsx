 "use client";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const { theme, setTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const activeTheme = theme === "system" ? systemTheme : theme;
  return (
    <button
      type="button"
      className="btn btn-outline"
      aria-label="Alternar tema"
      onClick={() => setTheme(activeTheme === "dark" ? "light" : "dark")}
    >
      {mounted && activeTheme === "dark" ? "??" : "??"}
    </button>
  );
}

