import './CrownMark.css';

interface CrownMarkProps {
  size?: number;
  animate?: boolean;
}

// The Helm circlet, same shape as the app icon, drawn with currentColor so it
// inherits the logo's text color. `animate` draws it on once and adds a soft
// continuous glow (disabled under prefers-reduced-motion).
export function CrownMark({ size = 18, animate = false }: CrownMarkProps) {
  return (
    <svg
      className={`crown-mark ${animate ? 'crown-mark--animate' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      aria-hidden="true"
    >
      <g className="crown-lines" stroke="currentColor" strokeWidth={78} strokeLinejoin="round" strokeLinecap="round">
        <ellipse cx="512" cy="556" rx="300" ry="84" />
        <path d="M 236 528 L 312 404 L 398 490 L 512 386 L 626 490 L 712 404 L 788 528" />
      </g>
      <g className="crown-pearls" fill="currentColor">
        <circle cx="312" cy="388" r="30" />
        <circle cx="512" cy="366" r="32" />
        <circle cx="712" cy="388" r="30" />
      </g>
    </svg>
  );
}
