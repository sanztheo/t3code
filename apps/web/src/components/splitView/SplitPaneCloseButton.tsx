import { useGT } from "gt-react";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What a chat shown in a split pane needs from the pane around it. */
export interface SplitPaneChrome {
  readonly onClose: () => void;
  /** Only the pane under the window's top-left controls makes room for them. */
  readonly atWindowStart: boolean;
}

/** Closes a split pane; it sits last among the pane's own header controls. */
export function SplitPaneCloseButton({ onClose }: { readonly onClose: () => void }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={gt("Close pane")}
            // A press here closes the pane without making it active first.
            data-split-pane-close=""
            className="ml-1 shrink-0 [-webkit-app-region:no-drag]"
            onClick={onClose}
          />
        }
      >
        <XIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{gt("Close pane")}</TooltipPopup>
    </Tooltip>
  );
}
