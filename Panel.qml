import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Ui as Ui
import qs.Commons
import qs.Commons as Commons
import "Model.js" as Model

Panel {
  id: root
  moduleName: "devgtv.docker"
  ipcTarget: "devgtv.docker"

  property bool dockerAvailable: false
  property string dockerVersion: ""
  property var dockerTarget: null
  property double hostMemBytes: 0
  property var containers: []

  // Keyboard cursor over the container list.
  property int selectedIndex: 0
  property bool cursorActive: false

  // true while the user is dragging a slider — pauses the periodic refresh
  // so the model does not change underneath the pointer.
  property bool userInteracting: false

  // Local per-container limit preview (name -> MB) while the
  // `docker update` is still in flight; keeps the knob from snapping back.
  property var memOverrides: ({})

  // Queue of pending `docker update` jobs: [{name, mb}]. One Process at a time.
  property var pendingSets: []
  property var activeSet: null
  property var keyboardEdits: ({})
  property string actionError: ""
  property string actionNotice: ""
  property var pendingAction: null
  property var activeAction: null
  property int mutationRevision: 0
  readonly property bool controlsBusy: userInteracting || memDebounce.running || setProc.running || activeSet !== null || pendingSets.length > 0 || actionProc.running || activeAction !== null || pendingAction !== null

  // Floor guards against a misconfigured refreshMs (0/negative would hammer
  // the daemon in a tight timer loop).
  readonly property int refreshMs: Math.max(500, setting("refreshMs", 3000))
  readonly property int hostMemMb: Model.hostMemoryMb(hostMemBytes)
  readonly property int memMin: 6
  readonly property int memStep: 128

  function containerLimitMb(c) {
    return c && c.memLimitBytes > 0 ? Math.round(c.memLimitBytes / 1048576) : 0
  }

  // Effective limit shown: local override > real limit > host RAM
  // (container with no configured limit).
  function effectiveMb(c) {
    if (!c) return memMin
    var override = memOverrides[c.name]
    if (override !== undefined) return override
    var limit = containerLimitMb(c)
    return limit > 0 ? limit : hostMemMb
  }

  function setOverride(name, mb) {
    var next = {}
    for (var key in memOverrides) next[key] = memOverrides[key]
    next[name] = mb
    memOverrides = next
  }

  function clearOverride(name) {
    if (memOverrides[name] === undefined) return
    var next = {}
    for (var key in memOverrides) if (key !== name) next[key] = memOverrides[key]
    memOverrides = next
  }

  // Drops pending overrides for containers that are no longer listed, so a
  // removed container cannot keep a stale limit preview behind in the slider.
  function pruneOverrides(names) {
    var next = {}
    for (var key in memOverrides) {
      if (names.indexOf(key) >= 0) next[key] = memOverrides[key]
    }
    if (Object.keys(next).length !== Object.keys(memOverrides).length) memOverrides = next
  }

  function refresh() {
    if (controlsBusy) return
    if (!refreshProc.running) {
      refreshProc.revision = mutationRevision
      refreshProc.running = true
    }
  }

  // --memory-swap -1 allows unlimited swap; it does not disable swapping.
  function setMemory(name, mb) {
    if (!name || !Model.validTarget(dockerTarget) || actionProc.running || pendingAction !== null) return
    var container = containers.filter(function(c) { return c.name === name })[0]
    if (!Model.validContainer(container) || container.status !== "running") return
    actionError = ""
    // A direct slider release supersedes an older debounced keyboard edit.
    var edits = {}
    for (var key in keyboardEdits) if (key !== name) edits[key] = keyboardEdits[key]
    keyboardEdits = edits
    var clamped = Model.clampMemMb(mb, hostMemMb)
    setOverride(name, clamped)

    var queue = pendingSets.slice()
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].name === name) {
        queue[i].mb = clamped
        pendingSets = queue
        startNextSet()
        return
      }
    }
    queue.push({ name: name, id: container.fullId, mb: clamped, target: dockerTarget })
    pendingSets = queue
    startNextSet()
  }

  function startNextSet() {
    if (setProc.running || activeSet !== null || pendingSets.length === 0) return
    var job = pendingSets[0]
    pendingSets = pendingSets.slice(1)
    activeSet = job
    activeSet.phase = "swap"
    mutationRevision += 1
    // Some runc/cgroup configurations reject a combined increase when the old
    // memory+swap limit is below the new RAM limit. Relax swap first.
    setProc.command = Model.dockerCommand(job.target, ["update", "--memory-swap", "-1", job.id])
    setProc.running = true
  }

  function finishSet(exitCode, exitStatus, errorText) {
    var job = activeSet
    if (!job) return
    if (exitCode === 0 && exitStatus === 0 && job.phase === "swap") {
      job.phase = "memory"
      // Process.exited can be emitted before running becomes false. Starting
      // another command synchronously here may be lost by the old process exit.
      Qt.callLater(function() {
        setProc.command = Model.dockerCommand(job.target, ["update", "--memory", String(job.mb) + "m", "--memory-swap", "-1", job.id])
        setProc.running = true
      })
      return
    }
    activeSet = null
    if (exitCode !== 0 || exitStatus !== 0)
      actionError = "Could not update " + job.name + ": " + (String(errorText || "").trim() || "Docker exited with code " + exitCode) + (job.phase === "memory" ? " (swap was already set to unlimited)" : "")
    var queued = pendingSets.some(function(item) { return item.name === job.name })
    if (!queued && keyboardEdits[job.name] === undefined) clearOverride(job.name)
    Qt.callLater(function() { root.startNextSet(); root.refresh() })
  }

  function moveCursor(delta) {
    if (containers.length === 0) return
    var next = selectedIndex + delta
    if (next < 0) next = 0
    if (next > containers.length - 1) next = containers.length - 1
    selectedIndex = next
  }

  function clampCursor() {
    if (containers.length === 0) {
      selectedIndex = 0
      return
    }
    if (selectedIndex > containers.length - 1) selectedIndex = containers.length - 1
    if (selectedIndex < 0) selectedIndex = 0
  }

  function adjustSelectedMem(deltaSteps) {
    if (actionProc.running || pendingAction !== null) return
    if (selectedIndex < 0 || selectedIndex >= containers.length) return
    var c = containers[selectedIndex]
    if (!c || c.status !== "running") return
    var next = Model.clampMemMb(effectiveMb(c) + deltaSteps * memStep, hostMemMb)
    setOverride(c.name, next)
    var edits = Object.assign({}, keyboardEdits)
    edits[c.name] = next
    keyboardEdits = edits
    memDebounce.restart()
  }

  function flushKeyboardEdits() {
    var edits = keyboardEdits
    keyboardEdits = ({})
    for (var name in edits) {
      if (containers.some(function(c) { return c.name === name })) setMemory(name, edits[name])
      else clearOverride(name)
    }
  }

  function requestAction(action, container) {
    if (controlsBusy || !dockerAvailable || !Model.validTarget(dockerTarget)) return
    if (!Model.canContainerAction(action, container)) return
    actionError = ""
    actionNotice = ""
    // Store the identity and target, not the mutable cursor or container name.
    pendingAction = { action: action, container: { fullId: container.fullId, status: container.status }, name: container.name, target: dockerTarget }
  }

  function cancelAction() {
    pendingAction = null
  }

  function confirmAction() {
    var job = pendingAction
    if (!job || actionProc.running) return
    var command = Model.containerActionCommand(job.target, job.action, job.container)
    pendingAction = null
    if (command.length === 0) return
    activeAction = job
    mutationRevision += 1
    actionProc.command = command
    actionProc.running = true
  }

  function finishAction(exitCode, exitStatus, errorText) {
    var job = activeAction
    activeAction = null
    if (!job) return
    if (exitCode !== 0 || exitStatus !== 0)
      actionError = "Could not " + job.action + " " + job.name + ": " + (String(errorText || "").trim() || "Docker exited with code " + exitCode)
    else actionNotice = "Completed " + job.action + " for " + job.name
    Qt.callLater(root.refresh)
  }

  function selectedAction(action) {
    if (!cursorActive || selectedIndex < 0 || selectedIndex >= containers.length) return
    var c = containers[selectedIndex]
    requestAction(action === "toggle" ? (c.status === "running" ? "stop" : "start") : action, c)
  }

  function openLogs(container, follow) {
    if (!dockerAvailable || pendingAction !== null) return
    var command = Model.logsCommand(dockerTarget, container, follow)
    if (command.length === 0) return
    Quickshell.execDetached(command)
    actionNotice = "Requested " + (follow ? "live logs" : "logs") + " for " + container.name
  }

  function selectedLogs(follow) {
    if (!cursorActive || selectedIndex < 0 || selectedIndex >= containers.length) return
    openLogs(containers[selectedIndex], follow)
  }

  function ensureCursorVisible(item) {
    if (!item || !scrollArea) return
    var flick = scrollArea.contentItem
    if (!flick || flick.contentY === undefined) return
    var pt = item.mapToItem(flick.contentItem || flick, 0, 0)
    var top = pt.y
    var bottom = top + (item.height || 0)
    var viewTop = flick.contentY
    var viewBottom = viewTop + flick.height
    var margin = 6
    if (top < viewTop + margin) flick.contentY = Math.max(0, top - margin)
    else if (bottom > viewBottom - margin)
      flick.contentY = bottom + margin - flick.height
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Component.onCompleted: refresh()

  onOpenedChanged: {
    if (!opened) cancelAction()
    if (opened) {
      refresh()
      selectedIndex = 0
      cursorActive = false
    }
  }

  onContainersChanged: clampCursor()

  Timer {
    interval: root.refreshMs
    running: root.opened
    repeat: true
    onTriggered: if (!root.userInteracting) root.refresh()
  }

  Process {
    id: refreshProc
    property int revision: 0
    command: ["bash", "-c", Model.snapshotScript]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        // A request already in flight must not recreate a dragged slider or
        // replace the model underneath a keyboard preview.
        if (root.controlsBusy || refreshProc.revision !== root.mutationRevision) return
        var snap = Model.parseSnapshot(String(text || ""))
        root.dockerAvailable = snap.dockerAvailable
        root.dockerVersion = snap.dockerVersion
        if (JSON.stringify(root.dockerTarget) !== JSON.stringify(snap.target)) root.memOverrides = ({})
        root.dockerTarget = snap.target
        root.hostMemBytes = snap.hostMemBytes
        root.containers = snap.containers
        root.pruneOverrides(snap.containers.map(function(c) { return c.name }))
      }
    }
    onExited: if (revision !== root.mutationRevision) Qt.callLater(root.refresh)
  }

  Process {
    id: actionProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { id: actionErrors; waitForEnd: true }
    onExited: function(exitCode, exitStatus) { root.finishAction(exitCode, exitStatus, actionErrors.text) }
  }

  Process {
    id: setProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { id: setErrors; waitForEnd: true }
    onExited: function(exitCode, exitStatus) { root.finishSet(exitCode, exitStatus, setErrors.text) }
  }

  // Debounce for keyboard (h/l) adjustments.
  Timer {
    id: memDebounce
    interval: 300
    repeat: false
    onTriggered: root.flushKeyboardEdits()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf308"
    onPressed: function(b) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    objectName: "dockerTestPanel"
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(Math.max(panelColumn.implicitHeight, root.pendingAction ? Style.space(360) : 0), Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      objectName: "dockerKeyCatcher"
      anchors.fill: parent
      blocked: root.pendingAction !== null
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
        else if (dx !== 0) root.adjustSelectedMem(dx)
      }
      onActivateRequested: if (root.cursorActive) root.refresh()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r") root.refresh()
        else if (t === "s") root.selectedAction("toggle")
        else if (t === "R") root.selectedAction("restart")
        else if (t === "g") root.selectedLogs(false)
        else if (t === "G") root.selectedLogs(true)
      }

      ScrollView {
        id: scrollArea
        objectName: "dockerScrollArea"
        anchors.fill: parent
        clip: true
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical.policy: panelColumn.implicitHeight > height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
        Binding {
          target: scrollArea.contentItem
          property: "interactive"
          value: panelColumn.implicitHeight > scrollArea.height
        }

        Column {
          id: panelColumn
          width: scrollArea.availableWidth
          spacing: Style.space(14)

          // ---------- Hero ----------
          Item {
            width: parent.width
            implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

            Text {
              id: heroIcon
              text: "\uf308"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.display
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            Column {
              id: heroLabels
              anchors.left: heroIcon.right
              anchors.leftMargin: Style.space(14)
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                text: "Docker"
                color: root.bar.foreground
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
                elide: Text.ElideRight
                width: parent.width
              }

              Text {
                text: {
                  if (!root.dockerAvailable) return "DAEMON UNAVAILABLE"
                  var n = root.containers.length
                  if (n === 0) return "NO CONTAINERS"
                  var running = root.containers.filter(function(c) { return c.status === "running" }).length
                  return running + " RUNNING · " + n + " TOTAL"
                }
                color: Qt.darker(root.bar.foreground, 1.4)
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
                elide: Text.ElideRight
                width: parent.width
              }
            }
          }

          // ---------- Docker unavailable ----------
          Text {
            width: parent.width
            text: Model.targetLabel(root.dockerTarget)
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }

          PanelSeparator {
            visible: !root.dockerAvailable
            foreground: root.bar.foreground
          }

          Text {
            visible: !root.dockerAvailable
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Could not reach the selected Docker daemon. Check the context, connection and your user's access (including rootless Docker)."
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            visible: root.actionError !== ""
            width: parent.width
            wrapMode: Text.WrapAnywhere
            textFormat: Text.PlainText
            text: root.actionError
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            visible: root.actionNotice !== "" || actionProc.running
            width: parent.width
            wrapMode: Text.WrapAnywhere
            textFormat: Text.PlainText
            text: actionProc.running && root.activeAction ? "Applying " + root.activeAction.action + " to " + root.activeAction.name + "…" : root.actionNotice
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }

          // ---------- Containers ----------
          Repeater {
            model: root.containers

            delegate: CursorSurface {
              id: containerRow
              objectName: "dockerRow-" + container.fullId
              required property var modelData
              required property int index

              readonly property var container: modelData

              width: panelColumn.width
              implicitHeight: rowColumn.implicitHeight + Style.spacing.xl
              hasCursor: root.cursorActive && root.selectedIndex === index
              onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(containerRow)
              foreground: root.bar.foreground
              fill: Style.hoverFillFor(root.bar.foreground, Commons.Color.accent)

              Column {
                id: rowColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(6)

                // Row 1: status dot · name · cpu/mem
                Item {
                  width: parent.width
                  implicitHeight: nameText.implicitHeight

                  Text {
                    id: statusDot
                    text: "●"
                    color: containerRow.container.status === "running" ? Commons.Color.accent : Qt.darker(root.bar.foreground, 1.6)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.body
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: nameText
                    textFormat: Text.PlainText
                    text: containerRow.container.name
                    color: root.bar.foreground
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                    elide: Text.ElideRight
                    anchors.left: statusDot.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: statsText.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: statsText
                    text: {
                      var c = containerRow.container
                      var parts = []
                      if (c.cpuPercent !== "") parts.push("CPU " + c.cpuPercent)
                      if (c.memUsageBytes > 0) parts.push(Model.formatBytes(c.memUsageBytes))
                      return parts.join(" · ")
                    }
                    color: Qt.darker(root.bar.foreground, 1.4)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                // Row 2: image
                Text {
                  text: containerRow.container.status + " · " + containerRow.container.image + " · " + containerRow.container.id
                  textFormat: Text.PlainText
                  color: Qt.darker(root.bar.foreground, 1.6)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: parent.width
                }

                Flow {
                  width: parent.width
                  spacing: Style.space(6)
                  Repeater {
                    model: ["start", "stop", "restart"]
                    delegate: Ui.Button {
                      required property string modelData
                      visible: Model.canContainerAction(modelData, containerRow.container)
                      text: modelData.charAt(0).toUpperCase() + modelData.slice(1)
                      foreground: root.bar.foreground
                      fontFamily: root.bar.fontFamily
                      fontSize: Style.font.caption
                      bordered: true
                      enabled: !root.controlsBusy && root.dockerAvailable && Model.validTarget(root.dockerTarget)
                      onClicked: root.requestAction(modelData, containerRow.container)
                    }
                  }
                  Ui.Button {
                    text: "Logs"
                    foreground: root.bar.foreground
                    fontFamily: root.bar.fontFamily
                    fontSize: Style.font.caption
                    bordered: true
                    enabled: root.dockerAvailable && Model.validTarget(root.dockerTarget) && root.pendingAction === null
                    onClicked: root.openLogs(containerRow.container, false)
                  }
                  Ui.Button {
                    text: "Follow logs"
                    foreground: root.bar.foreground
                    fontFamily: root.bar.fontFamily
                    fontSize: Style.font.caption
                    bordered: true
                    enabled: root.dockerAvailable && Model.validTarget(root.dockerTarget) && root.pendingAction === null
                    onClicked: root.openLogs(containerRow.container, true)
                  }
                }

                // Row 3: RAM limit header
                Item {
                  visible: containerRow.container.status === "running"
                  width: parent.width
                  implicitHeight: ramValue.implicitHeight

                  Text {
                    id: ramHeader
                    text: "RAM LIMIT"
                    color: Qt.darker(root.bar.foreground, 1.4)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    font.letterSpacing: 1.2
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: ramValue
                    text: {
                      var c = containerRow.container
                      var shown = ramSlider.dragging ? ramSlider.liveValue : root.effectiveMb(c)
                      var label = Model.formatMb(shown)
                      if (root.containerLimitMb(c) === 0 && root.memOverrides[c.name] === undefined)
                        label += " (unlimited)"
                      return label
                    }
                    color: Qt.darker(root.bar.foreground, 1.4)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                // Row 4: RAM slider
                PanelSlider {
                  id: ramSlider
                  objectName: "dockerMemory-" + containerRow.container.fullId
                  visible: containerRow.container.status === "running"
                  enabled: root.dockerAvailable && Model.validTarget(root.dockerTarget) && !actionProc.running && root.pendingAction === null
                  bar: root.bar
                  width: parent.width
                  minimum: root.memMin
                  maximum: root.hostMemMb
                  step: root.memStep
                  integer: true
                  value: root.effectiveMb(containerRow.container)
                  onMoved: function(v) {
                    root.userInteracting = true
                    root.setOverride(containerRow.container.name, v)
                  }
                  onReleased: function(v) {
                    root.userInteracting = false
                    root.setMemory(containerRow.container.name, v)
                  }
                }
              }

              // Do not steal slider clicks: HoverHandler only tracks the mouse and
              // updates the keyboard cursor without consuming the click.
              HoverHandler {
                onHoveredChanged: if (hovered) {
                  root.cursorActive = true
                  root.selectedIndex = containerRow.index
                }
              }
            }
          }

          // ---------- Footer ----------
          PanelSeparator {
            visible: root.containers.length > 0
            foreground: root.bar.foreground
          }

          Text {
            visible: root.containers.length > 0
            width: parent.width
            text: "j/k navigate · h/l RAM · s start/stop · Shift+r restart · g logs · Shift+g follow · r refresh"
            wrapMode: Text.WordWrap
            color: Qt.darker(root.bar.foreground, 1.6)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }

          Item {
            width: parent.width
            height: Style.space(4)
          }
        }
      }

      Item {
        id: confirmationKeys
        objectName: "dockerConfirmationKeys"
        anchors.fill: parent
        visible: root.pendingAction !== null
        z: 20
        onVisibleChanged: {
          if (visible) { actionConfirm.selectedIndex = 0; forceActiveFocus() }
          else keyCatcher.forceActiveFocus()
        }
        Keys.onPressed: function(event) {
          actionConfirm.handleKey(event)
          event.accepted = true
        }
        ConfirmDialog {
          id: actionConfirm
          objectName: "dockerActionConfirm"
          anchors.fill: parent
          opened: root.pendingAction !== null
          message: root.pendingAction ? "Confirm " + root.pendingAction.action + " for " + root.pendingAction.name + "?\n" + Model.targetLabel(root.pendingAction.target) + "\nStarting may execute the container workload; stopping or restarting may interrupt services." : ""
          confirmText: "Confirm"
          background: root.bar.background
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          onCanceled: root.cancelAction()
          onConfirmed: root.confirmAction()
        }
      }
    }
  }
}
