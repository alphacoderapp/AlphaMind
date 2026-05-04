export interface TabInfo {
  tabId: string
  ptyId: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  sessionId?: string
  isActive: boolean
}

class TabRegistry {
  private tabs = new Map<string, TabInfo>()
  private activeTabId: string | null = null

  set(tab: Omit<TabInfo, 'isActive'>): void {
    this.tabs.set(tab.tabId, { ...tab, isActive: tab.tabId === this.activeTabId })
  }

  remove(tabId: string): void {
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = null
  }

  setActive(tabId: string | null): void {
    this.activeTabId = tabId
    for (const [id, t] of this.tabs) {
      this.tabs.set(id, { ...t, isActive: id === tabId })
    }
  }

  getAll(): TabInfo[] {
    return Array.from(this.tabs.values())
  }

  get(tabId: string): TabInfo | undefined {
    return this.tabs.get(tabId)
  }

  getActive(): TabInfo | null {
    if (!this.activeTabId) return null
    return this.tabs.get(this.activeTabId) ?? null
  }

  clear(): void {
    this.tabs.clear()
    this.activeTabId = null
  }
}

export const tabRegistry = new TabRegistry()
