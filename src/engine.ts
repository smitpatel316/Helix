// The hidden "engine" window, open as long as Helix is: the app's one R, which
// every project window uses, and the menu bar while no project window is open.
import { evalNamedVector, onEngineStuck, startR } from "./stats/webr";
import { cancelR, onNoWindows, serveR } from "./native";
import { projectItems, setMenuBar } from "./menus";
import { loadRecents, saveRecents } from "./store/recents";

startR().catch(() => {}); // a failed boot is retried by the first request, which reports it
void serveR(evalNamedVector);

/** A calculation the interrupt could not free: this window's R is wedged, so
 *  drop the shell's waiting requests (or the hung code is re-sent when this
 *  window says it is ready) and reload — a fresh page boots a fresh R, and
 *  the wedged worker dies with the old page. The timed reload covers the
 *  shell call not landing before the first reload. */
onEngineStuck(() => {
  void cancelR().finally(() => window.location.reload());
  setTimeout(() => window.location.reload(), 2000);
});

/** With no project open, Helix stays open (as Pages does) with a menu bar to open one. */
function setWindowlessMenuBar() {
  const keepRecents = (paths: string[]) => {
    saveRecents(paths);
    setWindowlessMenuBar();
  };
  const recents = loadRecents();
  const forgetRecent = (path: string) => keepRecents(recents.filter((p) => p !== path));
  void setMenuBar([{ text: "File", items: projectItems(recents, forgetRecent, () => keepRecents([])) }]);
}
onNoWindows(setWindowlessMenuBar);
