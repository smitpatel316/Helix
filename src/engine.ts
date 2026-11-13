// The hidden "engine" window, open as long as Titer is: the app's one R, which
// every project window uses, and the menu bar while no project window is open.
import { evalNamedVector, onEngineStuck, startR } from "./stats/webr";
import { cancelR, onNoWindows, serveR } from "./native";
import { projectItems, setMenuBar } from "./menus";
import { loadRecents, saveRecents, recentKey, type RecentEntry } from "./store/recents";

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

/** With no project open, Titer stays open (as Pages does) with a menu bar to open one. */
function setWindowlessMenuBar() {
  const keepRecents = (entries: RecentEntry[]) => {
    saveRecents(entries);
    setWindowlessMenuBar();
  };
  const recents = loadRecents();
  const forgetRecent = (entry: RecentEntry) => keepRecents(recents.filter((e) => recentKey(e) !== recentKey(entry)));
  // Local files only: a remote file needs a project window to load into,
  // and there is none while this menu is showing. Remote recents open from
  // a project window's File menu instead.
  const local = recents.filter((e): e is Extract<RecentEntry, { kind: "local" }> => e.kind === "local");
  void setMenuBar([{ text: "File", items: projectItems(local, forgetRecent, () => keepRecents([])) }]);
}
onNoWindows(setWindowlessMenuBar);
