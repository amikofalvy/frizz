import { ChevronRight, Settings } from "lucide-react"
import { store } from "../store.ts"
import { useBackDismiss } from "../lib/backDismiss.ts"
import { MOBILE_MENU_ACTION, MOBILE_MENU_ICON, MOBILE_MENU_LABEL } from "../lib/mobileMenu.ts"
import { MobileBottomSheet } from "./MobileBottomSheet.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"

export function MobileBoardActionsSheet({ onClose }: { onClose: () => void }) {
  const dismiss = useBackDismiss(onClose)
  return (
    <MobileBottomSheet title="Board actions" onRequestClose={() => dismiss()} dataAttr="data-mobile-more-sheet">
      <div className="border-y border-border/70">
        <button
          type="button"
          data-mobile-settings
          data-mobile-settings-row
          onClick={() => dismiss(() => { store.showSettings = true })}
          className={MOBILE_MENU_ACTION}
        >
          <span className={MOBILE_MENU_LABEL}>
            <Settings className={`${MOBILE_MENU_ICON} text-muted-70`} aria-hidden="true" />
            <span className="min-w-0 flex-1">Settings</span>
            <ChevronRight className={`${MOBILE_MENU_ICON} text-muted-45`} aria-hidden="true" />
          </span>
        </button>
        <RestartFrizzButton mobile />
      </div>
    </MobileBottomSheet>
  )
}
