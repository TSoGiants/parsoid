'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ContentUtils } = require('../../../lib/utils/ContentUtils.js');
const { DOMUtils }  = require('../../../lib/utils/DOMUtils.js');

class PHPDOMPass {
	dumpDOMToFile(root, fileName) {
		const html = ContentUtils.ppToXML(root, {
			tunnelFosteredContent: true,
			keepTmp: true,
			storeDiffMark: true
		});
		fs.writeFileSync(fileName, html);
	}

	updateEnvUid(env, dom) {
		// Extract piggybacked env uid from <body>
		env.uid = parseInt(dom.body.getAttribute("data-env-newuid"), 10);
		dom.body.removeAttribute("data-env-newuid");
	}

	loadDOMFromStdout(inputBody, transformerName, atTopLevel, env, res) {
		const stdout = res.stdout.toString();

		let newDOM;

		if (transformerName === 'CleanUp-cleanupAndSaveDataParsoid') {
			// HACK IT! Cleanup only runs on the top-level.
			// For nested pipelines, the DOM is unmodified.
			// We aren't verifying this functionality since it adds
			// to the complexity of passing DOMs across JS/PHP.
			if (atTopLevel) {
				newDOM = DOMUtils.parseHTML(stdout);
				this.updateEnvUid(env, newDOM);
			} else {
				newDOM = inputBody.ownerDocument;
			}
		} else if (transformerName === 'Linter') {
			env.lintLogger.buffer = env.lintLogger.buffer.concat(JSON.parse(stdout));
			// DOM is not modified
			newDOM = inputBody.ownerDocument;
		} else {
			newDOM = ContentUtils.ppToDOM(env, stdout, {
				reinsertFosterableContent: true,
				markNew: true
			}).ownerDocument;
			this.updateEnvUid(env, newDOM);
		}

		return newDOM;
	}

	runPHPCode(argv, opts) {
		const res = childProcess.spawnSync("php", [
			path.resolve(__dirname, "runDOMPass.php")
		].concat(argv), {
			input: JSON.stringify(opts),
			stdio: [ 'pipe', 'pipe', process.stderr ],
		});
		if (res.error) {
			throw res.error;
		}
		return res;
	}

	wt2htmlPP(transformerName, root, env, options, atTopLevel) {
		if (!(/^[\w\-]+$/.test(transformerName))) {
			console.error("Transformer name failed sanity check.");
			process.exit(-1);
		}

		const hackyEnvOpts = {
			currentUid: env.uid,
			// These are the only env properties used by DOM processors
			// in wt2html/pp/processors/*. Handlers may use other properties.
			// We can cross that bridge when we get there.
			wrapSections: env.wrapSections,
			rtTestMode: env.conf.parsoid.rtTestMode,
			pageContent: env.page.src,
			sourceOffsets: options.sourceOffsets,
			tidyWhitespaceBugMaxLength: env.conf.parsoid.linter.tidyWhitespaceBugMaxLength,
			discardDataParsoid: env.discardDataParsoid,
			pageBundle: env.pageBundle,
		};

		const fileName = `/tmp/${transformerName}.${process.pid}.html`;
		this.dumpDOMToFile(root, fileName);
		const res = this.runPHPCode([transformerName, fileName], {
			hackyEnvOpts,
			atTopLevel: !!atTopLevel,  // Force bool before serializing
			runOptions: options || {},
		});

		return this.loadDOMFromStdout(root, transformerName, atTopLevel, env, res);
	}

	diff(env, domA, domB) {
		const hackyEnvOpts = {
			// These are the only env properties used by DOMDiff code
			rtTestMode: env.conf.parsoid.rtTestMode,
			pageContent: env.page.src,
			pageId: env.page.id,
		};

		const fileName1 = `/tmp/diff.${process.pid}.f1.html`;
		this.dumpDOMToFile(domA, fileName1);
		const fileName2 = `/tmp/diff.${process.pid}.f2.html`;
		this.dumpDOMToFile(domB, fileName2);
		const res = this.runPHPCode(["DOMDiff", fileName1, fileName2], { hackyEnvOpts });
		const stdout = res.stdout.toString();

		const ret = JSON.parse(stdout);
		ret.dom = ContentUtils.ppToDOM(env, ret.html, {
			reinsertFosterableContent: true,
			markNew: true
		}).ownerDocument.body;

		this.updateEnvUid(env, ret.dom.ownerDocument);

		return ret;
	}

	normalizeDOM(state, body) {
		const hackyEnvOpts = {
			// These are the only env properties used by DOMDiff code
			pageContent: state.env.page.src,
			rtTestMode: state.rtTestMode,
			selserMode: state.selserMode,
			scrubWikitext: state.env.scrubWikitext,
		};

		const fileName = `/tmp/normalize.${process.pid}${state.selserMode ? '.selser' : ''}.html`;
		this.dumpDOMToFile(body, fileName);
		const res = this.runPHPCode(["DOMNormalizer", fileName], { hackyEnvOpts });
		return this.loadDOMFromStdout(body, 'normalizeDOM', true, state.env, res).body;
	}
}

if (typeof module === "object") {
	module.exports.PHPDOMPass = PHPDOMPass;
}
