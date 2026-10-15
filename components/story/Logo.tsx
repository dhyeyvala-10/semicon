/** The site's mark: a small chip. Inline SVG, so it stays sharp on every screen. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" fill="var(--bg)" />
      <path
        d="M9 1.8v2.4M12 1.8v2.4M15 1.8v2.4M9 19.8v2.4M12 19.8v2.4M15 19.8v2.4M1.8 9h2.4M1.8 12h2.4M1.8 15h2.4M19.8 9h2.4M19.8 12h2.4M19.8 15h2.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <>
      <LogoMark />
      <span className="logo-name">FAB/TWIN</span>
    </>
  );
}
