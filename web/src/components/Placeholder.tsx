interface PlaceholderProps {
  label: string
  hint?: string
  accent?: string
  rounded?: boolean
}

export function Placeholder({
  label,
  hint,
  accent = 'rgba(255,255,255,0.4)',
  rounded = true,
}: PlaceholderProps) {
  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '24px 24px',
        textAlign: 'center',
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
        borderRadius: rounded ? 16 : 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          color: 'rgba(255,255,255,0.3)',
          fontWeight: 500,
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: accent,
            opacity: 0.6,
          }}
        />
        Screenshot
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'rgba(255,255,255,0.65)',
          lineHeight: 1.4,
          maxWidth: 320,
          letterSpacing: '-0.01em',
        }}
      >
        {label}
      </div>
      {hint && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.3)',
            lineHeight: 1.6,
            maxWidth: 320,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  )
}
