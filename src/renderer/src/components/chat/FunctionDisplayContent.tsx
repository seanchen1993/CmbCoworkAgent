import type { ReactNode } from "react"
import type { ModObject } from "../../../../shared/mods/types"
import type { FunctionDisplaySnapshotData } from "../../../../shared/mods/v2/display-snapshot"
import { functionSiteDefault } from "../../../../shared/mods/v2/sites"
import { functionNativeProps } from "../../lib/function-native-content"
import { Element } from "./FunctionPanes"

/** No owner, generation, Client or Markdown action sidecar is created for passive data. */
export function FunctionDisplayContent({
  data,
  renderNative
}: {
  data: FunctionDisplaySnapshotData
  renderNative?(props: ModObject): ReactNode
}): ReactNode {
  if (data.hostMessage)
    return renderNative ? renderNative(data.hostMessage) :
      <Element node={functionSiteDefault(data.component, data.hostMessage)} busy act={async () => {}} />
  return (
    <Element
      node={data.tree ?? { type: "engine", ref: 0 }}
      busy
      act={async () => {}}
      renderEngine={(ref) => {
        const props = functionNativeProps(data.nativeContent, ref)
        if (!props) return null
        if (renderNative) return renderNative(props)
        return (
          <Element node={functionSiteDefault(data.component, props)} busy act={async () => {}} />
        )
      }}
    />
  )
}
