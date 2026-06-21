const { invoke } = window.__TAURI__.core;

// State management
let currentTab = "dashboard";
let processesData = [];
let sortColumn = "cpu";
let sortAscending = false;
let systemStatsInterval = null;

// Helper to format bytes to human readable sizes (GB, MB, KB)
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Show Toast notification
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${message}</span>
  `;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Tab navigation handler
function setupNavigation() {
  const menuItems = document.querySelectorAll(".menu-item");
  menuItems.forEach(item => {
    item.addEventListener("click", () => {
      const target = item.getAttribute("data-target");
      
      // Toggle menu active classes
      menuItems.forEach(mi => mi.classList.remove("active"));
      item.classList.add("active");
      
      // Toggle tab active classes
      document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
      document.getElementById(target).classList.add("active");
      
      currentTab = target;
      tabChanged(target);
    });
  });
}

// Handle tab activation logic
function tabChanged(tabId) {
  // Clear dashboard intervals if not active to save battery/resources
  if (tabId !== "dashboard") {
    if (systemStatsInterval) {
      clearInterval(systemStatsInterval);
      systemStatsInterval = null;
    }
  } else {
    startDashboardMonitor();
  }

  if (tabId === "processes") {
    refreshProcesses();
  }
}

// Dashboard Module
async function updateDashboardMetrics() {
  try {
    const stats = await invoke("get_system_stats");
    
    // RAM Calculation
    const ramPercent = Math.round((stats.used_memory / stats.total_memory) * 100);
    document.getElementById("ram-value").textContent = `${ramPercent}%`;
    document.getElementById("ram-used").textContent = formatBytes(stats.used_memory, 1);
    document.getElementById("ram-total").textContent = formatBytes(stats.total_memory, 0);
    
    // Update RAM Circle SVG Progress
    const ramCircle = document.getElementById("ram-progress-circle");
    const offset = 251.2 - (251.2 * ramPercent) / 100;
    ramCircle.style.strokeDashoffset = offset;
    
    // CPU Calculation
    const cpuPercent = Math.round(stats.cpu_global_usage);
    document.getElementById("cpu-value").textContent = `${cpuPercent}%`;
    document.getElementById("process-count").textContent = stats.process_count;
    document.getElementById("zombie-count").textContent = stats.zombie_count;
    
    // Warn if zombies exist
    if (stats.zombie_count > 0) {
      document.getElementById("zombie-count").classList.add("warning");
    } else {
      document.getElementById("zombie-count").classList.remove("warning");
    }
    
    // Update CPU Circle SVG Progress
    const cpuCircle = document.getElementById("cpu-progress-circle");
    const cpuOffset = 251.2 - (251.2 * cpuPercent) / 100;
    cpuCircle.style.strokeDashoffset = cpuOffset;
    
  } catch (err) {
    console.error("Failed to read system metrics:", err);
  }
}

function startDashboardMonitor() {
  updateDashboardMetrics();
  if (!systemStatsInterval) {
    systemStatsInterval = setInterval(updateDashboardMetrics, 2000);
  }
}

// Processes Module
async function refreshProcesses() {
  const tbody = document.getElementById("processes-list");
  tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Refreshing list of active processes...</td></tr>`;
  
  try {
    const list = await invoke("get_processes");
    processesData = list;
    renderProcesses();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">Failed to fetch active processes.</td></tr>`;
    showToast("Error loading processes", "error");
  }
}

function renderProcesses() {
  const tbody = document.getElementById("processes-list");
  const searchQuery = document.getElementById("process-search").value.toLowerCase().trim();
  
  // Filter processes
  let filtered = processesData.filter(p => {
    return p.name.toLowerCase().includes(searchQuery) || p.pid.toString().includes(searchQuery);
  });
  
  // Sort processes
  filtered.sort((a, b) => {
    let fieldA = a[sortColumn];
    let fieldB = b[sortColumn];
    
    if (sortColumn === "cpu") {
      fieldA = a.cpu_usage;
      fieldB = b.cpu_usage;
    } else if (sortColumn === "memory") {
      fieldA = a.memory_usage;
      fieldB = b.memory_usage;
    }
    
    if (fieldA < fieldB) return sortAscending ? -1 : 1;
    if (fieldA > fieldB) return sortAscending ? 1 : -1;
    return 0;
  });
  
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No processes match the query.</td></tr>`;
    return;
  }
  
  tbody.innerHTML = filtered.map(p => {
    const memoryMB = formatBytes(p.memory_usage, 1);
    const cpuStr = `${p.cpu_usage.toFixed(1)}%`;
    const isZombie = p.status === "Zombie";
    return `
      <tr class="${isZombie ? 'warning-row' : ''}">
        <td><strong>${p.pid}</strong></td>
        <td>${p.name}</td>
        <td>${cpuStr}</td>
        <td>${memoryMB}</td>
        <td><span class="status-badge status-${p.status.toLowerCase()}">${p.status}</span></td>
        <td class="text-right">
          <button class="btn btn-danger btn-sm" onclick="killProcessByPid(${p.pid}, '${p.name}')">Kill</button>
        </td>
      </tr>
    `;
  }).join('');
}

// Kill Process Handler
window.killProcessByPid = async function(pid, name) {
  const confirmed = confirm(`Are you sure you want to terminate process "${name}" (PID: ${pid})?`);
  if (!confirmed) return;
  
  try {
    const success = await invoke("kill_process", { pid });
    if (success) {
      showToast(`Process ${name} (PID: ${pid}) terminated successfully.`);
      refreshProcesses();
    } else {
      showToast(`Failed to terminate ${name}. Permission denied or process died.`, "error");
    }
  } catch (err) {
    showToast(`Error terminating process: ${err}`, "error");
  }
};

// Setup table sorting listeners
function setupTableSorting() {
  document.querySelectorAll(".sortable").forEach(header => {
    header.addEventListener("click", () => {
      const field = header.getAttribute("data-sort");
      if (sortColumn === field) {
        sortAscending = !sortAscending;
      } else {
        sortColumn = field;
        sortAscending = false;
      }
      
      // Simple UI feedback
      document.querySelectorAll(".sortable").forEach(sh => sh.innerHTML = sh.textContent);
      header.innerHTML = header.textContent + (sortAscending ? " ▲" : " ▼");
      
      renderProcesses();
    });
  });
}

// Disk Cleanup Module
let scannedGarbageFolders = [];

async function scanGarbage() {
  const container = document.getElementById("garbage-folders-list");
  container.innerHTML = `
    <div class="empty-state">
      <p>Scanning directory contents, calculating files and paths... Please wait...</p>
    </div>
  `;
  
  try {
    const folders = await invoke("scan_garbage_folders");
    scannedGarbageFolders = folders;
    renderGarbageCards();
  } catch (err) {
    container.innerHTML = `<div class="empty-state text-danger">Failed to scan directories: ${err}</div>`;
    showToast("Scan failed", "error");
  }
}

function renderGarbageCards() {
  const container = document.getElementById("garbage-folders-list");
  if (scannedGarbageFolders.length === 0) {
    container.innerHTML = `<div class="empty-state">No target folders could be analyzed.</div>`;
    return;
  }

  container.innerHTML = scannedGarbageFolders.map(folder => {
    const sizeStr = formatBytes(folder.size, 1);
    const hasData = folder.size > 0;
    return `
      <div class="garbage-card glass ${hasData ? 'has-data' : 'empty'}">
        <input type="checkbox" class="garbage-checkbox" data-id="${folder.id}" ${hasData ? 'checked' : 'disabled'} />
        <div class="garbage-details">
          <span class="garbage-title">${folder.name}</span>
          <span class="garbage-path">${folder.path}</span>
          <span class="garbage-meta ${hasData ? 'warning' : 'text-muted'}">${sizeStr} (${folder.file_count} files)</span>
        </div>
      </div>
    `;
  }).join('');

  // Setup checkbox changes to activate/deactivate clean button
  const checkboxes = document.querySelectorAll(".garbage-checkbox");
  const cleanBtn = document.getElementById("btn-clean-garbage");
  
  const updateButtonState = () => {
    const checked = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.getAttribute("data-id"));
    if (checked.length > 0) {
      cleanBtn.removeAttribute("disabled");
      cleanBtn.classList.remove("disabled");
    } else {
      cleanBtn.setAttribute("disabled", "true");
      cleanBtn.classList.add("disabled");
    }
  };
  
  checkboxes.forEach(cb => cb.addEventListener("change", updateButtonState));
  updateButtonState();
}

async function cleanGarbage() {
  const checkboxes = document.querySelectorAll(".garbage-checkbox:checked");
  const foldersToClean = Array.from(checkboxes).map(cb => cb.getAttribute("data-id"));
  if (foldersToClean.length === 0) return;

  const confirmed = confirm("Are you sure you want to delete all files in the selected folders? This action is permanent!");
  if (!confirmed) return;

  const cleanBtn = document.getElementById("btn-clean-garbage");
  cleanBtn.setAttribute("disabled", "true");
  cleanBtn.classList.add("disabled");
  cleanBtn.textContent = "Cleaning files...";

  try {
    const bytesFreed = await invoke("clean_garbage", { folders: foldersToClean });
    showToast(`Successfully deleted cache. Freed ${formatBytes(bytesFreed, 1)}.`);
    scanGarbage(); // Rescan sizes
  } catch (err) {
    showToast(`Error during cleanup: ${err}`, "error");
  } finally {
    cleanBtn.textContent = "Clean Selected";
  }
}

// Large Files Finder Module
async function scanLargeFiles() {
  const minSizeMb = parseInt(document.getElementById("min-size-select").value);
  const tbody = document.getElementById("large-files-list");
  tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">Scanning documents and downloads... This might take a few moments...</td></tr>`;

  try {
    const list = await invoke("scan_large_files", { minSizeMb });
    renderLargeFiles(list);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">Failed to scan directories: ${err}</td></tr>`;
    showToast("Scan failed", "error");
  }
}

function renderLargeFiles(list) {
  const tbody = document.getElementById("large-files-list");
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No files found exceeding the selected size threshold.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(file => {
    return `
      <tr>
        <td><strong>${file.name}</strong></td>
        <td class="text-muted" style="word-break: break-all; font-size:11px;">${file.path}</td>
        <td><strong>${formatBytes(file.size, 1)}</strong></td>
        <td class="text-right">
          <button class="btn btn-danger btn-sm" onclick="deleteLargeFile('${encodeURIComponent(file.path)}', '${file.name}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

window.deleteLargeFile = async function(encodedPath, name) {
  const pathStr = decodeURIComponent(encodedPath);
  const confirmed = confirm(`Are you sure you want to permanently delete "${name}"?\nPath: ${pathStr}`);
  if (!confirmed) return;

  try {
    const success = await invoke("delete_file", { pathStr });
    if (success) {
      showToast(`File "${name}" deleted successfully.`);
      scanLargeFiles(); // Refresh list
    } else {
      showToast(`Failed to delete "${name}". Permission denied.`, "error");
    }
  } catch (err) {
    showToast(`Error deleting file: ${err}`, "error");
  }
};

// Event registration
window.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupTableSorting();
  
  // Dashboard
  startDashboardMonitor();
  document.getElementById("btn-quick-scan").addEventListener("click", () => {
    const cleanItem = document.querySelector(".menu-item[data-target='cleanup']");
    if (cleanItem) {
      cleanItem.click();
      scanGarbage();
    }
  });

  // Processes
  document.getElementById("btn-refresh-processes").addEventListener("click", refreshProcesses);
  document.getElementById("process-search").addEventListener("input", renderProcesses);

  // Disk Cleanup
  document.getElementById("btn-scan-garbage").addEventListener("click", scanGarbage);
  document.getElementById("btn-clean-garbage").addEventListener("click", cleanGarbage);

  // Large Files
  document.getElementById("btn-scan-large-files").addEventListener("click", scanLargeFiles);
});
