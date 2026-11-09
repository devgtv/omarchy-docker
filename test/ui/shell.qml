import QtQuick
import QtTest
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
  Process { id: denyWrites; command: ["docker", "test-deny"] }
  QtObject {
    id: fakeBar
    property color foreground: "#eeeeee"
    property color barForeground: "#eeeeee"
    property color background: "#111111"
    property color urgent: "#ff5555"
    property string fontFamily: "monospace"
    property string position: "top"
    property bool vertical: false
    property int barSize: 32
    property bool foregroundAnimationEnabled: false
    property var activePopout: null
    function hideTooltip(item) {}
    function showTooltip(item, text) {}
    function requestPopout(item) { activePopout = item }
    function releasePopout(item) { if (activePopout === item) activePopout = null }
  }
  PanelWindow {
    anchors { top: true; left: true; right: true }
    implicitHeight: 32
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    WlrLayershell.namespace: "docker-plugin-ui-test-anchor"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    Loader {
      id: plugin
      x: 40
      width: 32
      height: 32
      Component.onCompleted: setSource(Quickshell.env("DOCKER_PLUGIN_TEST_PATH") + "/Panel.qml", {bar: fakeBar, manageIpc: false, settings: {refreshMs: 60000}})
    }
    Timer {
      property bool started: false
      interval: 10
      running: !started && plugin.status === Loader.Ready && plugin.item.containers.length === 2
      onTriggered: {
        started = true
        try { suite.exercise() }
        catch (error) {
          console.error("UI FAILURE: " + error + "\n" + error.stack)
          console.error(JSON.stringify({busy: plugin.item.controlsBusy, active: plugin.item.activeAction, pending: plugin.item.pendingAction, notice: plugin.item.actionNotice, error: plugin.item.actionError, cursor: plugin.item.selectedIndex, states: plugin.item.containers.map(function(c) { return c.status })}))
        }
        finally { if (plugin.item) plugin.item.close(); Qt.callLater(Qt.quit) }
      }
    }
    TestCase {
      id: suite
      name: "DockerPanelRuntime"
      when: false
      function descendant(item, predicate) {
        if (predicate(item)) return item
        if (!item.children) return null
        for (var i = 0; i < item.children.length; i++) {
          var result = descendant(item.children[i], predicate)
          if (result) return result
        }
        return null
      }
      function exercise() {
        var p = plugin.item
        p.open()
        wait(300)
        verify(p.opened)
        var panel = findChild(p, "dockerTestPanel")
        var keys = findChild(p, "dockerKeyCatcher")
        var dialog = findChild(p, "dockerActionConfirm")
        verify(panel && keys && dialog, "actual panel components must exist")
        suite.parent = keys
        var card = keys.parent.parent
        mouseMove(card, card.width + 20, 10)
        grabImage(card).save(Quickshell.env("DOCKER_PLUGIN_UI_OUTPUT") + "/panel.png")
        verify(findChild(keys, "dockerMemory-" + "a".repeat(64)).visible)
        verify(!findChild(keys, "dockerMemory-" + "b".repeat(64)).visible)
        keyClick(Qt.Key_Down)
        verify(p.cursorActive)
        compare(p.selectedIndex, 0)
        keyClick(Qt.Key_Down)
        compare(p.selectedIndex, 1)
        keyClick(Qt.Key_Up)
        compare(p.selectedIndex, 0)

        keyClick(Qt.Key_S)
        tryVerify(function() { return p.pendingAction !== null })
        compare(dialog.selectedIndex, 0, "Cancel must be selected initially")
        keyClick(Qt.Key_Return)
        compare(p.pendingAction, null, "Enter must initially cancel, not execute")
        compare(p.containers[0].status, "running")
        keyClick(Qt.Key_S)
        keyClick(Qt.Key_Escape)
        compare(p.pendingAction, null)
        verify(p.opened, "Escape in confirmation must not close the panel")

        keyClick(Qt.Key_S)
        keyClick(Qt.Key_R)
        keyClick(Qt.Key_L)
        compare(p.pendingAction.action, "stop", "background shortcuts must be blocked")
        compare(Object.keys(p.keyboardEdits).length, 0)
        keyClick(Qt.Key_Tab)
        compare(dialog.selectedIndex, 1)
        keyClick(Qt.Key_Return)
        tryVerify(function() { return p.containers[0].status === "exited" && !p.controlsBusy })
        wait(100)
        compare(p.actionError, "")

        p.selectedIndex = 0
        keys.forceActiveFocus()
        keyClick(Qt.Key_S)
        compare(p.pendingAction.container.fullId, "a".repeat(64))
        keyClick(Qt.Key_Right)
        keyClick(Qt.Key_Return)
        tryVerify(function() { return p.containers[0].status === "running" && !p.controlsBusy })
        wait(100)
        keys.forceActiveFocus()
        p.cursorActive = true
        p.selectedIndex = 0
        keyClick(Qt.Key_L)
        tryVerify(function() { return p.containers[0].memLimitBytes === 192 * 1048576 })
        wait(150)
        var row = findChild(keys, "dockerRow-" + "a".repeat(64))
        var restart = descendant(row, function(item) { return item.text === "Restart" && typeof item.clicked === "function" })
        verify(restart, "mouse action button must exist")
        grabImage(card).save(Quickshell.env("DOCKER_PLUGIN_UI_OUTPUT") + "/before-mouse.png")
        mouseClick(restart)
        tryVerify(function() { return p.pendingAction !== null && p.pendingAction.action === "restart" })
        p.close()
        compare(p.pendingAction, null, "closing the panel cancels confirmation")

        p.open()
        wait(250)
        keys.forceActiveFocus()
        p.cursorActive = true
        p.selectedIndex = 0
        keyClick("R", Qt.ShiftModifier)
        tryVerify(function() { return p.pendingAction !== null && p.pendingAction.action === "restart" })
        keyClick(Qt.Key_Escape)
        keyClick(Qt.Key_G)
        tryVerify(function() { return p.actionNotice.indexOf("Requested logs") === 0 })
        keyClick("G", Qt.ShiftModifier)
        tryVerify(function() { return p.actionNotice.indexOf("Requested live logs") === 0 })
        wait(150)

        denyWrites.running = true
        tryVerify(function() { return !denyWrites.running })
        p.requestAction("stop", p.containers[0])
        keyClick(Qt.Key_Right)
        keyClick(Qt.Key_Return)
        tryVerify(function() { return p.actionError.indexOf("Synthetic permission denied") >= 0 && !p.controlsBusy })
        compare(p.containers[0].status, "running", "failed write must not pretend the container stopped")
        wait(150)

        panel.contentWidth = 280
        wait(150)
        grabImage(card).save(Quickshell.env("DOCKER_PLUGIN_UI_OUTPUT") + "/panel-narrow.png")
        p.requestAction("restart", p.containers[0])
        wait(150)
        grabImage(card).save(Quickshell.env("DOCKER_PLUGIN_UI_OUTPUT") + "/confirmation-narrow.png")
        verify(dialog.width > 0 && dialog.height > 0)
        mouseClick(card, card.width + 20, 10)
        tryVerify(function() { return !p.opened && p.pendingAction === null })
        p.open()
        wait(250)
        var many = p.containers.slice()
        for (var i = 1; i <= 8; i++) many.push({fullId: String(i).repeat(64), id: String(i).repeat(12), name: "extra-ui-container-" + i, status: "running", image: "busybox:test", memLimitBytes: 67108864, cpuPercent: "0.1%", memUsageBytes: 1048576})
        p.containers = many
        wait(150)
        p.cursorActive = true
        p.selectedIndex = many.length - 1
        wait(150)
        verify(findChild(p, "dockerScrollArea").contentItem.contentY > 0, "keyboard cursor must scroll to the final container")
        grabImage(card).save(Quickshell.env("DOCKER_PLUGIN_UI_OUTPUT") + "/panel-scroll.png")
        p.close()
        console.log("UI ASSERTIONS PASSED")
      }
      function cleanupTestCase() {
        if (plugin.item) plugin.item.close()
      }
    }
  }
}
