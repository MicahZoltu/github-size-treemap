/*
 * This file is loaded as a classic (non-module) script so that it works when opened via file:// (double-clicking index.html).
 * ES module scripts (<script type="module" src="...">) are blocked on file:// origins because the browser cannot fetch local files with the CORS protocol that modules require.
 * Classic scripts, however, load local files via "embedding" which is permitted even with opaque file:// origins.
 *
 * Since we still need to import the "squarified" library from an HTTPS CDN, we use dynamic import() — which is available in classic scripts and works for cross-origin HTTPS resources that send proper CORS headers.
 *
 * All code is wrapped in an async IIFE so we can await the dynamic imports before using the library's exports.
 *
 * See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules#other_differences_between_modules_and_classic_scripts
 * See: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy#file_origins
 */
(async function() {
	const { createTreemap, c2m, definePlugin } = await import('https://esm.sh/squarified@1.1.1')
	const { presetColorPlugin, presetHighlightPlugin, presetZoomablePlugin, presetScalePlugin, presetDragElementPlugin } = await import('https://esm.sh/squarified@1.1.1/plugin')

	//
	// Input Parsing
	//

	function parseRepoInput(input) {
		const raw = input.trim()
		if (!raw) return null

		let owner, repo, branch = null

		// SSH URL: git@github.com:owner/repo.git or git@github.com:owner/repo
		const sshMatch = raw.match(/^git@github\.com:(.+?)(?:\.git)?(?:@(.*))?$/)
		if (sshMatch) {
			const path = sshMatch[1]
			branch = sshMatch[2] || null
			const parts = path.split('/')
			if (parts.length === 2) { owner = parts[0]; repo = parts[1] }
			else return null
			return { owner, repo, branch: branch || null }
		}

		// HTTPS URL: https://github.com/owner/repo.git[/...]
		const httpsMatch = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/)
		if (httpsMatch) {
			owner = httpsMatch[1]
			repo = httpsMatch[2]
			// Try to extract branch from /tree/<branch> path
			const treeMatch = raw.match(/\/tree\/([^/?#]+)/)
			branch = treeMatch ? treeMatch[1] : null
			return { owner, repo, branch: branch || null }
		}

		// Short form: owner/repo.git[@branch]
		const shortMatch = raw.match(/^([^/@]+)\/([^/@]+?)(?:\.git)?(?:@(.+))?$/)
		if (shortMatch) {
			owner = shortMatch[1]
			repo = shortMatch[2]
			branch = shortMatch[3] || null
			return { owner, repo, branch: branch || null }
		}

		return null
	}

	//
	// API Layer
	//

	async function fetchDefaultBranch(owner, repo, token) {
		const headers = { 'Accept': 'application/vnd.github.v3+json' }
		if (token) headers['Authorization'] = `Bearer ${token}`

		const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })

		if (!resp.ok) {
			const status = resp.status
			if (status === 403) throw { code: 'RATE_LIMIT', status, message: 'Rate limited' }
			if (status === 404) throw { code: 'NOT_FOUND', status, message: `Repository ${owner}/${repo} not found` }
			const body = await resp.json().catch(() => ({}))
			throw { code: 'HTTP_ERROR', status, message: body.message || `HTTP ${status}` }
		}

		const data = await resp.json()
		return data.default_branch
	}

	async function fetchRepoTree(owner, repo, branch, token, onProgress) {
		let ref = branch
		if (!ref) {
			onProgress('Detecting default branch…')
			ref = await fetchDefaultBranch(owner, repo, token)
		}

		const headers = { 'Accept': 'application/vnd.github.v3+json' }
		if (token) headers['Authorization'] = `Bearer ${token}`

		onProgress(`Fetching tree for ${ref}…`)

		const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers } )

		if (!resp.ok) {
			const status = resp.status
			if (status === 403) throw { code: 'RATE_LIMIT', status, message: 'Rate limited' }
			if (status === 404) throw { code: 'NOT_FOUND', status, message: `Ref "${ref}" not found` }
			const body = await resp.json().catch(() => ({}))
			throw { code: 'HTTP_ERROR', status, message: body.message || `HTTP ${status}` }
		}

		const data = await resp.json()
		const entries = data.tree
		if (!entries || !entries.length) {
			throw { code: 'EMPTY', message: 'No tree entries found' }
		}

		return entries
			.filter(e => e.type === 'blob' && (e.size || 0) > 0)
			.map(e => ({ path: e.path, size: e.size }))
	}

	//
	// Data Transformation
	//

	function flatToTree(flatEntries) {
		const root = {}

		for (const { path, size } of flatEntries) {
			const parts = path.split('/')
			let current = root
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i]
				if (i === parts.length - 1) {
					current[part] = { name: part, size, leaf: true }
				} else {
					if (!current[part]) {
						current[part] = { name: part, children: {}, leaf: false }
					}
					current = current[part].children
				}
			}
		}

		return objectToNode(root)
	}

	function objectToNode(obj) {
		const nodes = []
		for (const key of Object.keys(obj)) {
			const val = obj[key]
			if (val.leaf) {
				nodes.push({ id: key, label: key, weight: val.size })
			} else {
				const childNodes = objectToNode(val.children)
				childNodes.sort((a, b) => b.weight - a.weight)
				const totalWeight = childNodes.reduce((s, c) => s + c.weight, 0)
				nodes.push({ id: key, label: key, weight: totalWeight, groups: childNodes })
			}
		}
		return nodes
	}

	function prepareTreemapData(flatEntries) {
		const treeNodes = flatToTree(flatEntries)
		treeNodes.sort((a, b) => b.weight - a.weight)
		return treeNodes.map(n => c2m(n, 'weight'))
	}

	//
	// Formatting Helpers
	//

	function formatSize(bytes) {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
	}

	//
	// UI Helpers
	//

	const $ = id => document.getElementById(id)

	function showToast(message, type = 'info', duration = 5000) {
		const toast = $('toast')
		toast.textContent = message
		toast.className = type
		toast.style.display = 'block'
		clearTimeout(toast._timer)
		if (duration > 0) {
			toast._timer = setTimeout(() => { toast.style.display = 'none' }, duration)
		}
	}

	function showLoading(text) {
		$('loading').classList.add('visible')
		$('loading-text').textContent = text || 'Loading…'
	}

	function hideLoading() {
		$('loading').classList.remove('visible')
	}

	//
	// Treemap Setup
	//

	let treemap = null
	let currentData = null

	function initTreemap() {
		const container = $('treemap-renderer')
		const tooltip = $('tooltip')

		const tooltipPlugin = definePlugin({
			name: 'treemap:tooltip',
			onDOMEventTriggered (name, event, graphic, domEvent) {
				if (name !== 'mousemove') {
					tooltip.style.display = 'none'
					return
				}
				const { stateManager: state } = domEvent
				if (!state.canTransition('MOVE') || !graphic || !graphic.__widget__) {
					tooltip.style.display = 'none'
					return
				}
				const node = graphic.__widget__.node
				const path = node.label || ''
				const weight = node.weight
				tooltip.querySelector('.path').textContent = path
				tooltip.querySelector('.size').textContent = weight ? formatSize(weight) : ''
				tooltip.style.display = 'block'
				const nx = event.native ? event.native.clientX : 0
				const ny = event.native ? event.native.clientY : 0
				tooltip.style.left = (nx + 14) + 'px'
				tooltip.style.top = (ny + 14) + 'px'
			}
		})

		treemap = createTreemap({
			graphic: {
				fill: {
					mode: 'rgb',
					desc: { r: 13, g: 17, b: 23 }
				}
			},
			plugins: [ presetColorPlugin, presetHighlightPlugin, presetZoomablePlugin, presetScalePlugin(), presetDragElementPlugin, tooltipPlugin ]
		})

		treemap.init(container)

		let resizeTimer = null
		window.addEventListener('resize', () => {
			clearTimeout(resizeTimer)
			resizeTimer = setTimeout(() => treemap.resize(), 100)
		})
	}

	function renderTreemap(flatEntries) {
		if (!flatEntries || flatEntries.length === 0) return

		const data = prepareTreemapData(flatEntries)
		currentData = data

		treemap.setOptions({ data })
	}

	//
	// Main Logic
	//

	async function visualize() {
		const input = $('repo-input').value
		const token = $('token-input').value.trim()
		const branchInput = $('branch-input').value.trim() || null
		const parsed = parseRepoInput(input)

		if (!parsed) {
			showToast('Invalid repository format. Use owner/repo or a GitHub URL.', 'error')
			return
		}

		const { owner, repo, branch: parsedBranch } = parsed
		const branch = parsedBranch || branchInput
		const btn = $('visualize-btn')
		btn.disabled = true
		$('toast').style.display = 'none'
		showLoading(`Fetching ${owner}/${repo}…`)

		try {
			const entries = await fetchRepoTree(owner, repo, branch, token, (msg) => $('loading-text').textContent = msg)

			hideLoading()
			renderTreemap(entries)
			showToast(`Loaded ${entries.length} files from ${owner}/${repo}`, 'success', 3000)
		} catch (err) {
			hideLoading()
			if (err.code === 'NOT_FOUND') {
				showToast(`Repository not found: ${owner}/${repo}`, 'error')
			} else if (err.code === 'RATE_LIMIT') {
				showToast('API rate limited. Enter a GitHub token for higher limits.', 'error', 8000)
			} else if (err.code === 'EMPTY') {
				showToast('No files found in this repository.', 'info')
			} else {
				showToast(err.message || 'Failed to fetch repository.', 'error')
			}
		} finally {
			btn.disabled = false
		}
	}

	//
	// Event Wiring
	//

	$('visualize-btn').addEventListener('click', visualize)

	$('reset-btn').addEventListener('click', () => {
		if (currentData) treemap.setOptions({ data: currentData })
	})

	$('repo-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') visualize()
	})

	$('repo-input').focus()

	initTreemap()
})()
