import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  searchLibraries,
  installLibrary,
  getInstalledLibraries,
  uninstallLibrary,
} from '../../services/libraryService';
import type { ArduinoLibrary, InstalledLibrary } from '../../services/libraryService';
import { trackInstallLibrary } from '../../utils/analytics';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
import './LibraryManagerModal.css';

interface LibraryManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Tab = 'project' | 'search' | 'installed';

/** Case/separator-insensitive name match, matching the backend's
 *  _norm_lib_name (lowercased, alphanumerics only) so the UI's "in project"
 *  state agrees with what the compiler scopes. */
const normLib = (s: string): string =>
  (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const LibraryManagerModal: React.FC<LibraryManagerModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('search');
  // P2.4 — manifests are PER-BOARD: the velxio.json edited here belongs to the
  // ACTIVE board, so two boards in one project can scope to different libraries.
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const updateBoard = useSimulatorStore((s) => s.updateBoard);
  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  const manifestLibs = activeBoard?.libraries ?? null;
  const setLibraries = useCallback(
    (libs: string[] | null) => {
      if (!activeBoard) return;
      updateBoard(activeBoard.id, { libraries: libs && libs.length ? libs : undefined });
    },
    [activeBoard, updateBoard],
  );
  // Raw velxio.json editor draft + parse error (the Wokwi-style view).
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [newLibName, setNewLibName] = useState('');
  // Autocomplete suggestions for the "add library" field (index search).
  const [addSuggestions, setAddSuggestions] = useState<string[]>([]);
  const addDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ArduinoLibrary[]>([]);
  const [installedLibraries, setInstalledLibraries] = useState<InstalledLibrary[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingInstalled, setLoadingInstalled] = useState(false);
  const [installingLib, setInstallingLib] = useState<string | null>(null);
  const [uninstallingLib, setUninstallingLib] = useState<string | null>(null);
  /** Track user-selected version per library name */
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const libs = await getInstalledLibraries();
      setInstalledLibraries(libs);
    } catch (e: unknown) {
      setStatusMsg({
        type: 'error',
        text: e instanceof Error ? e.message : 'Failed to load installed libraries',
      });
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setStatusMsg(null);
    }
  }, [isOpen]);

  // Fetch installed list when modal opens or switching to installed tab
  useEffect(() => {
    if (isOpen && activeTab === 'installed') fetchInstalled();
  }, [isOpen, activeTab, fetchInstalled]);

  useEffect(() => {
    if (isOpen) fetchInstalled();
  }, [isOpen, fetchInstalled]);

  // Search: immediate on open (empty query), debounced when typing
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const delay = searchQuery ? 400 : 0;
    debounceRef.current = setTimeout(async () => {
      setLoadingSearch(true);
      setStatusMsg(null);
      try {
        const results = await searchLibraries(searchQuery);
        setSearchResults(results);
      } catch (e: unknown) {
        setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Search failed' });
        setSearchResults([]);
      } finally {
        setLoadingSearch(false);
      }
    }, delay);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, isOpen]);

  const handleInstall = async (libName: string) => {
    setInstallingLib(libName);
    setStatusMsg(null);
    try {
      const version = selectedVersions[libName];
      const result = await installLibrary(libName, version);
      if (result.success) {
        trackInstallLibrary(libName);
        // P2.4 — installing a library declares it for THIS project (adds it to
        // velxio.json), so the compile is scoped to it and it never clashes
        // with another project's libs. The user can remove it in the Project tab.
        addToManifest(libName);
        if (result.fallback) {
          setStatusMsg({ type: 'success', text: `"${libName}" installed and added to this project (latest — requested @${result.requested_version} was not available)` });
        } else {
          setStatusMsg({ type: 'success', text: `"${libName}${version ? ' @' + version : ''}" installed and added to this project!` });
        }
        fetchInstalled();
      } else {
        setStatusMsg({ type: 'error', text: result.error || `Failed to install "${libName}"` });
      }
    } catch (e: unknown) {
      setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Installation failed' });
    } finally {
      setInstallingLib(null);
    }
  };

  const handleUninstall = async (libName: string) => {
    setUninstallingLib(libName);
    setStatusMsg(null);
    try {
      const result = await uninstallLibrary(libName);
      if (result.success) {
        setStatusMsg({ type: 'success', text: `"${libName}" uninstalled successfully!` });
        fetchInstalled();
      } else {
        setStatusMsg({ type: 'error', text: result.error || `Failed to uninstall "${libName}"` });
      }
    } catch (e: unknown) {
      setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Uninstall failed' });
    } finally {
      setUninstallingLib(null);
    }
  };

  // ── Project manifest (velxio.json) editing ──────────────────────────────
  const declared = manifestLibs ?? [];

  const inManifest = useCallback(
    (name: string): boolean => declared.some((l) => normLib(l) === normLib(name)),
    [declared],
  );

  const addToManifest = useCallback(
    (name: string) => {
      const clean = name.trim();
      if (!clean) return;
      const cur = manifestLibs ?? [];
      if (cur.some((l) => normLib(l) === normLib(clean))) return;
      setLibraries([...cur, clean]);
    },
    [manifestLibs, setLibraries],
  );

  const removeFromManifest = useCallback(
    (name: string) => {
      const cur = manifestLibs ?? [];
      const next = cur.filter((l) => normLib(l) !== normLib(name));
      setLibraries(next.length ? next : null);
    },
    [manifestLibs, setLibraries],
  );

  // Autocomplete: debounced index search for the "add library" field. Combined
  // with instant matches from the installed list in `addOptions` below.
  useEffect(() => {
    if (addDebounceRef.current) clearTimeout(addDebounceRef.current);
    const q = newLibName.trim();
    if (q.length < 2) {
      setAddSuggestions([]);
      return;
    }
    addDebounceRef.current = setTimeout(async () => {
      try {
        const results = await searchLibraries(q);
        setAddSuggestions(results.map((r) => r.name).filter(Boolean));
      } catch {
        setAddSuggestions([]);
      }
    }, 300);
    return () => {
      if (addDebounceRef.current) clearTimeout(addDebounceRef.current);
    };
  }, [newLibName]);

  // Merged, de-duped suggestions: installed libs first (instant), then index
  // results, excluding what's already declared. Capped for a tidy dropdown.
  const addOptions = (() => {
    const q = normLib(newLibName);
    if (!q) return [];
    const installedNames = installedLibraries
      .map((il) => il.library?.name || il.name || '')
      .filter(Boolean);
    const merged: string[] = [];
    for (const n of [...installedNames, ...addSuggestions]) {
      if (!normLib(n).includes(q)) continue;
      if (declared.some((d) => normLib(d) === normLib(n))) continue;
      if (merged.some((m) => normLib(m) === normLib(n))) continue;
      merged.push(n);
    }
    return merged.slice(0, 8);
  })();

  const applyJsonDraft = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonDraft || '{}');
      const libs = Array.isArray(parsed) ? parsed : parsed.libraries;
      if (!Array.isArray(libs) || !libs.every((x) => typeof x === 'string')) {
        setJsonError('Expected {"libraries": ["Name", ...]}');
        return;
      }
      setJsonError(null);
      setLibraries(libs.length ? (libs as string[]) : null);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }, [jsonDraft, setLibraries]);

  // Open the Project (velxio.json) tab when launched from the explorer entry.
  useEffect(() => {
    const toProject = () => setActiveTab('project');
    window.addEventListener('velxio-open-library-manager', toProject);
    return () => window.removeEventListener('velxio-open-library-manager', toProject);
  }, []);

  // Keep the raw velxio.json draft in sync with the manifest while not editing.
  useEffect(() => {
    setJsonDraft(JSON.stringify({ libraries: manifestLibs ?? [] }, null, 2));
    setJsonError(null);
  }, [manifestLibs, isOpen]);

  const handleClose = () => {
    onClose();
  };

  if (!isOpen) return null;

  const isInstalled = (libName: string): boolean =>
    installedLibraries.some(
      (il) => (il.library?.name || il.name || '').toLowerCase() === libName.toLowerCase(),
    );

  const getLibName = (lib: ArduinoLibrary): string => lib.name || 'Unknown';
  const getLibVersion = (lib: ArduinoLibrary): string => lib.latest?.version || lib.version || '';
  const getLibAuthor = (lib: ArduinoLibrary): string => lib.latest?.author || lib.author || '';
  const getLibDesc = (lib: ArduinoLibrary): string => lib.latest?.sentence || lib.sentence || '';

  const getInstalledName = (lib: InstalledLibrary): string =>
    lib.library?.name || lib.name || 'Unknown';
  const getInstalledVersion = (lib: InstalledLibrary): string =>
    lib.library?.version || lib.version || '';
  const getInstalledAuthor = (lib: InstalledLibrary): string =>
    lib.library?.author || lib.author || '';
  const getInstalledDesc = (lib: InstalledLibrary): string =>
    lib.library?.sentence || lib.sentence || '';

  return (
    <div className="lib-modal-overlay" onClick={handleClose}>
      <div className="lib-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="lib-modal-header">
          <div className="lib-modal-title">
            <svg
              className="lib-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
              <path d="m3.3 7 8.7 5 8.7-5" />
              <path d="M12 22V12" />
            </svg>
            <span>{t('editor.libraryManager.title')}</span>
          </div>
          <button className="lib-close-btn" onClick={handleClose}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="lib-tabs">
          <button
            className={`lib-tab ${activeTab === 'project' ? 'active' : ''}`}
            onClick={() => setActiveTab('project')}
          >
            In project ({declared.length})
          </button>
          <button
            className={`lib-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            {t('editor.libraryManager.searchTab')}
          </button>
          <button
            className={`lib-tab ${activeTab === 'installed' ? 'active' : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            {t('editor.libraryManager.installedTab')}
          </button>
        </div>

        {/* Status bar */}
        {statusMsg && (
          <div className={`lib-status ${statusMsg.type}`}>
            {statusMsg.type === 'success' ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
            {statusMsg.text}
          </div>
        )}

        {/* Project Tab — velxio.json: the libraries THIS project declares.
            These (plus the arduino-esp32 core) are the ESP32 compile scope, so
            the project never picks up another project's or user's libraries. */}
        {activeTab === 'project' && (
          <div className="lib-content">
            <div style={{ padding: '10px 14px', color: '#9d9d9d', fontSize: 12, lineHeight: 1.5 }}>
              Libraries used by{' '}
              <strong style={{ color: '#a5d6a7' }}>
                {activeBoard ? boardDisplayName(activeBoard) : 'this board'}
              </strong>{' '}
              (its <strong style={{ color: '#ffd60a' }}>velxio.json</strong>). Each
              board has its own list, so two boards can use different libraries
              without clashing. Installing a library adds it here automatically;
              start typing below to add more.
            </div>

            {/* Declared libraries as removable rows */}
            <div className="lib-list" style={{ maxHeight: 220 }}>
              {declared.length === 0 && (
                <div className="lib-empty">
                  <p>No libraries declared.</p>
                  <p className="lib-empty-sub">
                    Core libraries (WiFi, Wire, SPI, WebServer…) are always
                    available. Add external libraries from the Search tab or below.
                  </p>
                </div>
              )}
              {declared.map((name, i) => (
                <div key={i} className="lib-item">
                  <div className="lib-item-info">
                    <div className="lib-item-header">
                      <span className="lib-item-name">{name}</span>
                    </div>
                  </div>
                  <div className="lib-item-actions">
                    <button
                      className="lib-uninstall-btn"
                      onClick={() => removeFromManifest(name)}
                      title="Remove from this project (velxio.json)"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Add a library — autocomplete (installed + index search) so the
                user picks from a list instead of typing the exact name. */}
            <div style={{ position: 'relative', marginTop: 8 }}>
              <div className="lib-search-bar" style={{ margin: 0 }}>
                <input
                  type="text"
                  placeholder="Add a library — start typing to search…"
                  value={newLibName}
                  onChange={(e) => setNewLibName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const pick = addOptions[0] ?? newLibName;
                      if (pick.trim()) {
                        addToManifest(pick);
                        setNewLibName('');
                        setAddSuggestions([]);
                      }
                    } else if (e.key === 'Escape') {
                      setNewLibName('');
                      setAddSuggestions([]);
                    }
                  }}
                />
              </div>
              {addOptions.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    zIndex: 5,
                    background: '#252526',
                    border: '1px solid #3c3c3c',
                    borderRadius: 4,
                    marginTop: 2,
                    maxHeight: 200,
                    overflowY: 'auto',
                    boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
                  }}
                >
                  {addOptions.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => {
                        addToManifest(opt);
                        setNewLibName('');
                        setAddSuggestions([]);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '7px 12px',
                        background: 'transparent',
                        border: 'none',
                        color: '#d4d4d4',
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#094771')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Raw velxio.json editor (Wokwi-style) for power users */}
            <details style={{ padding: '6px 14px 14px', color: '#9d9d9d', fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
                Edit velxio.json directly
              </summary>
              <textarea
                value={jsonDraft}
                onChange={(e) => setJsonDraft(e.target.value)}
                spellCheck={false}
                style={{
                  width: '100%',
                  minHeight: 110,
                  marginTop: 8,
                  background: '#1e1e1e',
                  color: '#d4d4d4',
                  border: '1px solid #2d2d2d',
                  borderRadius: 4,
                  fontFamily: 'monospace',
                  fontSize: 12,
                  padding: 8,
                  boxSizing: 'border-box',
                }}
              />
              {jsonError && (
                <div className="lib-status error" style={{ marginTop: 6 }}>
                  {jsonError}
                </div>
              )}
              <button className="lib-install-btn" style={{ marginTop: 8 }} onClick={applyJsonDraft}>
                Apply velxio.json
              </button>
            </details>
          </div>
        )}

        {/* Search Tab */}
        {activeTab === 'search' && (
          <div className="lib-content">
            <div className="lib-search-bar">
              <svg
                className="lib-search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder={t('editor.libraryManager.filterPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              {loadingSearch && (
                <svg
                  className="lib-spinner"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              )}
            </div>

            <div className="lib-list">
              {loadingSearch && (
                <div className="lib-empty">
                  <svg
                    className="lib-spinner lib-spinner-center"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <p className="lib-empty-sub">
                    {searchQuery
                      ? t('editor.libraryManager.searchingFor', { query: searchQuery })
                      : t('editor.libraryManager.loadingLibraries')}
                  </p>
                </div>
              )}
              {!loadingSearch && searchResults.length === 0 && (
                <div className="lib-empty">
                  <p>
                    {searchQuery
                      ? t('editor.libraryManager.noResultsFor', { query: searchQuery })
                      : t('editor.libraryManager.noResults')}
                  </p>
                </div>
              )}
              {!loadingSearch &&
                searchResults.map((lib, i) => (
                  <div key={i} className="lib-item">
                    <div className="lib-item-info">
                      <div className="lib-item-header">
                        <span className="lib-item-name">{getLibName(lib)}</span>
                        {getLibAuthor(lib) && (
                          <span className="lib-item-author">
                            {t('editor.libraryManager.byAuthor', { author: getLibAuthor(lib) })}
                          </span>
                        )}
                      </div>
                      {getLibDesc(lib) && <p className="lib-item-desc">{getLibDesc(lib)}</p>}
                    </div>
                    <div className="lib-item-actions">
                      {isInstalled(getLibName(lib)) ? (
                        <>
                          <span className="lib-item-version lib-installed-badge">
                            {selectedVersions[lib.name] ?? lib.latest?.version ?? ''}
                            <svg style={{ display: 'inline', marginLeft: '4px', verticalAlign: 'middle' }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                          </span>
                          <button
                            className="lib-uninstall-btn"
                            onClick={() => handleUninstall(getLibName(lib))}
                            disabled={uninstallingLib !== null}
                          >
                            {uninstallingLib === getLibName(lib)
                              ? t('editor.libraryManager.uninstalling')
                              : t('editor.libraryManager.uninstall')}
                          </button>
                        </>
                      ) : (
                        <>
                          {lib.releases && Object.keys(lib.releases).length > 1 && (
                            <select
                              className="lib-version-select"
                              value={selectedVersions[lib.name] ?? lib.latest?.version ?? ''}
                              onChange={(e) => setSelectedVersions((prev) => ({ ...prev, [lib.name]: e.target.value }))}
                            >
                              {Object.entries(lib.releases).map(([ver]) => (
                                <option key={ver} value={ver}>{ver}</option>
                              ))}
                            </select>
                          )}
                          <button
                            className="lib-install-btn"
                            onClick={() => handleInstall(getLibName(lib))}
                            disabled={installingLib !== null}
                          >
                            {installingLib === getLibName(lib) ? (
                              <span className="lib-installing">{t('editor.libraryManager.installing')}</span>
                            ) : (
                              t('editor.libraryManager.install')
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Installed Tab */}
        {activeTab === 'installed' && (
          <div className="lib-content">
            <div className="lib-list">
              {loadingInstalled && (
                <div className="lib-empty">
                  <p>{t('editor.libraryManager.loadingInstalled')}</p>
                </div>
              )}
              {!loadingInstalled && installedLibraries.length === 0 && (
                <div className="lib-empty">
                  <p>{t('editor.libraryManager.noneInstalled')}</p>
                  <p className="lib-empty-sub">{t('editor.libraryManager.useSearchTab')}</p>
                </div>
              )}
              {installedLibraries.map((lib, i) => (
                <div key={i} className="lib-item">
                  <div className="lib-item-info">
                    <div className="lib-item-header">
                      <span className="lib-item-name">{getInstalledName(lib)}</span>
                      {getInstalledAuthor(lib) && (
                        <span className="lib-item-author">
                          {t('editor.libraryManager.byAuthor', { author: getInstalledAuthor(lib) })}
                        </span>
                      )}
                    </div>
                    {getInstalledDesc(lib) && (
                      <p className="lib-item-desc">{getInstalledDesc(lib)}</p>
                    )}
                  </div>
                  <div className="lib-item-actions">
                    {getInstalledVersion(lib) && (
                      <span className="lib-item-version lib-installed-badge">
                        {getInstalledVersion(lib)}
                        <svg
                          style={{ display: 'inline', marginLeft: '4px', verticalAlign: 'middle' }}
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                    )}
                    {inManifest(getInstalledName(lib)) ? (
                      <button
                        className="lib-uninstall-btn"
                        onClick={() => removeFromManifest(getInstalledName(lib))}
                        title="Remove from this project (velxio.json)"
                      >
                        In project ✓
                      </button>
                    ) : (
                      <button
                        className="lib-install-btn"
                        onClick={() => addToManifest(getInstalledName(lib))}
                        title="Add to this project (velxio.json)"
                      >
                        Add to project
                      </button>
                    )}
                    <button
                      className="lib-uninstall-btn"
                      onClick={() => handleUninstall(getInstalledName(lib))}
                      disabled={uninstallingLib !== null}
                    >
                      {uninstallingLib === getInstalledName(lib) ? 'Uninstalling...' : 'UNINSTALL'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
