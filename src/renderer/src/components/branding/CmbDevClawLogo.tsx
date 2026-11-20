import logoUrl from "@/assets/cmbdevclaw-logo-transparent-128.png"

interface CmbDevClawLogoProps {
  className?: string
}

export function CmbDevClawLogo({ className }: CmbDevClawLogoProps): React.JSX.Element {
  return <img src={logoUrl} alt="" aria-hidden="true" draggable={false} className={className} />
}
