import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Model

Panel {
  id: root
  moduleName: "devgtv.docker"
  ipcTarget: "devgtv.docker"

  property bool dockerAvailable: false
  property string dockerVersion: ""
  property int hostMemBytes: 0
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

  // Floor guards against a misconfigured refreshMs (0/negative would hammer
  // the daemon in a tight timer loop).
  readonly property int refreshMs: Math.max(500, setting("refreshMs", 3000))
  readonly property int hostMemMb: Math.max(16384, Math.round(hostMemBytes / 1048576))
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
    if (!refreshProc.running) refreshProc.running = true
  }

  // Applies `docker update --memory <mb>m`. --memory-swap -1 follows along so the
  // daemon rejects limits larger than the currently configured swap.
  function setMemory(name, mb) {
    if (!name) return
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
    queue.push({ name: name, mb: clamped })
    pendingSets = queue
    startNextSet()
  }

  function startNextSet() {
    if (setProc.running || pendingSets.length === 0) return
    var job = pendingSets[0]
    pendingSets = pendingSets.slice(1)
    setProc.command = ["docker", "update", "--memory", String(job.mb) + "m", "--memory-swap", "-1", job.name]
    setProc.running = true
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
    if (selectedIndex < 0 || selectedIndex >= containers.length) return
    var c = containers[selectedIndex]
    if (!c) return
    var next = Model.clampMemMb(effectiveMb(c) + deltaSteps * memStep, hostMemMb)
    setOverride(c.name, next)
    memDebounce.restart()
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
    command: ["bash", "-c", Model.snapshotScript]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var snap = Model.parseSnapshot(String(text || ""))
        root.dockerAvailable = snap.dockerAvailable
        root.dockerVersion = snap.dockerVersion
        root.hostMemBytes = snap.hostMemBytes
        root.containers = snap.containers
        root.pruneOverrides(snap.containers.map(function(c) { return c.name }))
      }
    }
  }

  Process {
    id: setProc
    property string finishedName: ""
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onRunningChanged: {
      if (running) {
        // The in-flight job name is the 6th argument of the command.
        finishedName = String(command[6] || "")
        return
      }
      root.clearOverride(finishedName)
      root.startNextSet()
      root.refresh()
    }
  }

  // Debounce for keyboard (h/l) adjustments.
  Timer {
    id: memDebounce
    interval: 300
    repeat: false
    onTriggered: {
      if (root.selectedIndex < 0 || root.selectedIndex >= root.containers.length) return
      var c = root.containers[root.selectedIndex]
      if (!c) return
      root.setMemory(c.name, root.effectiveMb(c))
    }
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
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
        else if (dx !== 0) root.adjustSelectedMem(dx)
      }
      onActivateRequested: if (root.cursorActive) root.refresh()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) { if (t === "r") root.refresh() }

      ScrollView {
        id: scrollArea
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
                  if (n === 0) return "NO RUNNING CONTAINERS"
                  return (n + (n === 1 ? " RUNNING CONTAINER" : " RUNNING CONTAINERS")).toUpperCase()
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
          PanelSeparator {
            visible: !root.dockerAvailable
            foreground: root.bar.foreground
          }

          Text {
            visible: !root.dockerAvailable
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Could not reach the Docker daemon. Make sure it is running and that your user is in the docker group."
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
          }

          // ---------- Containers ----------
          Repeater {
            model: root.containers

            delegate: CursorSurface {
              id: containerRow
              required property var modelData
              required property int index

              readonly property var container: modelData

              width: panelColumn.width
              implicitHeight: rowColumn.implicitHeight + Style.spacing.xl
              hasCursor: root.cursorActive && root.selectedIndex === index
              onHasCursorChanged: if (hasCursor) root.ensureCursorVisible(containerRow)
              foreground: root.bar.foreground
              fill: Style.hoverFillFor(root.bar.foreground, Color.accent)

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
                    color: containerRow.container.status === "running" ? Color.accent : Qt.darker(root.bar.foreground, 1.6)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.body
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: nameText
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
                  text: containerRow.container.image + " · " + containerRow.container.id
                  color: Qt.darker(root.bar.foreground, 1.6)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: parent.width
                }

                // Row 3: RAM limit header
                Item {
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
            text: "j/k navigate · h/l adjust RAM · r refresh"
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
    }
  }
}
