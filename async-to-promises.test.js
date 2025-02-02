const asyncToPromises = require("./async-to-promises");
const babel6 = require("babel-core");
const types6 = require("babel-types");
const babel7 = require("@babel/core");
const types7 = require("@babel/types");
const babylon = require("babylon");
const fs = require("fs");
const util = require("util");

const checkTestCases = true;
const checkOutputMatches = true;
const testsToRun = [];
const shouldWriteOutput = false;

const environments = {
	"babel 6": {
		babel: babel6,
		types: types6,
		pluginUnderTest: asyncToPromises(babel6),
		pluginMapping: {
			"transform-modules-commonjs": "babel-plugin-transform-es2015-modules-commonjs",
			"transform-parameters": "babel-plugin-transform-es2015-parameters",
			"transform-classes": "babel-plugin-transform-es2015-classes",
			"external-helpers": "babel-plugin-external-helpers",
		},
	},
	"babel 7": {
		babel: babel7,
		types: types7,
		pluginUnderTest: asyncToPromises(babel7),
		pluginMapping: {
			"transform-modules-commonjs": "@babel/plugin-transform-modules-commonjs",
			"transform-parameters": "@babel/plugin-transform-parameters",
			"transform-classes": "@babel/plugin-transform-classes",
			"external-helpers": "@babel/plugin-external-helpers",
		},
	},
};

const helperNames = ["_Pact", "_settle", "_isSettledPact", "_async", "_await", "_awaitIgnored", "_continue", "_continueIgnored", "_forTo", "_forValues", "_forIn", "_forOwn", "_forOf", "_forAwaitOf", "_for", "_do", "_switch", "_call", "_callIgnored", "_invoke", "_invokeIgnored", "_catch", "_finallyRethrows", "_finally", "_rethrow", "_empty", "_earlyReturn", "_catchInGenerator", "_wrapReturnedValue", "_wrapYieldedValue", "_AsyncGenerator", "_iteratorSymbol", "_asyncIteratorSymbol"];

const stripHelpersVisitor = {
	FunctionDeclaration(path) {
		// Remove function declaration of a helper
		if (helperNames.indexOf(path.node.id.name) === -1) {
			path.skip();
		} else {
			path.remove();
		}
	},
	VariableDeclarator(path) {
		// Remove variable declarator of a helper
		if (helperNames.indexOf(path.node.id.name) === -1) {
			path.skip();
		} else if (path.isFunction() && path.id) {
			path.skip();
		} else if (path.isVariableDeclaration()) {
			const allDeclarations = path.get("declarations");
			const declarationsToRemove = allDeclarations.filter(declaration => /^_async/.test(declaration.node.id.name));
			if (declarationsToRemove.length === allDeclarations.length) {
				path.remove();
			} else {
				for (const declaration of allDeclarations) {
					declaration.remove();
				}
				path.skip();
			}
		} else if (!path.node.ignored) {
			path.remove();
		}
	},
	AssignmentExpression(path) {
		// Remove assignment to a helper
		if (path.parentPath.isExpressionStatement()) {
			let left = path.get("left");
			while (left.isMemberExpression()) {
				left = left.get("object");
			}
			if (left.isIdentifier() && helperNames.indexOf(left.node.name) !== -1) {
				path.parentPath.remove();
			}
		}
	}
};

function extractOnlyUserCode(babel, result) {
	return babel.transformFromAst(result.ast, result.code, { plugins: [{ visitor: stripHelpersVisitor }], compact: true, ast: false }).code;
}

function extractJustFunction(babel, result) {
	const extracted = extractOnlyUserCode(babel, result);
	const match = extracted.match(/(^return\s*)?([\s\S]*);\s*$/);
	return match ? match[2] : extracted;
}

function writeOutput(name, myCode, outputCode) {
	if (shouldWriteOutput) {
		if (fs.existsSync(name)) {
			fs.unlinkSync(name);
		}
		if (typeof outputCode === "undefined" || myCode !== outputCode) {
			fs.writeFileSync(name, myCode);
		} else {
			fs.symlinkSync("output.js", name);
		}
	}
}

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

function readTest(name) {
	let input;
	let output;
	let inlined;
	let hoisted;
	let options;
	const cases = Object.create(null);
	for (const fileName of fs.readdirSync(`tests/${name}`)) {
		const content = fs.readFileSync(`tests/${name}/${fileName}`).toString();
		if (fileName === "input.js") {
			input = content;
		} else if (fileName === "output.js") {
			output = content;
		} else if (fileName === "inlined.js") {
			inlined = content;
		} else if (fileName === "hoisted.js") {
			hoisted = content;
		} else if (fileName === "options.json") {
			options = JSON.parse(content);
		} else {
			const caseMatch = fileName.match(/^case-(.*)\.js$/);
			if (caseMatch !== null) {
				cases[caseMatch[1]] = new AsyncFunction("f", content);
			}
		}
	}
	const { error, checkSyntax = true, module = false, plugins = [], supportedBabels = Object.keys(environments), presets = [] } = options || {};
	return {
		error,
		checkSyntax,
		module,
		input,
		output,
		inlined,
		hoisted,
		cases,
		plugins,
		supportedBabels,
		presets,
	};
}

function parse(babel, input) {
	return babel.parse ? babel.parse(input, { parserOpts: { allowReturnOutsideFunction: true, plugins: ["asyncGenerators"] }, sourceType: "module" }) : babylon.parse(input, { allowReturnOutsideFunction: true, sourceType: "module", plugins: ["asyncGenerators", "objectRestSpread"] });
}

for (const { babel } of Object.values(environments)) {
	parse(babel, "let test;");
}

for (const name of fs.readdirSync("tests").sort()) {
	if (testsToRun.length && testsToRun.indexOf(name) === -1) {
		continue;
	}
	if (fs.statSync(`tests/${name}`).isDirectory()) {
		describe(name, () => {
			const { input, output, inlined, hoisted, cases, error, checkSyntax, module, plugins, presets, supportedBabels } = readTest(name);
			for (const babelName of supportedBabels) {
				describe(babelName, () => {
					const { babel, types, pluginUnderTest, pluginMapping } = environments[babelName];
					const mappedPlugins = plugins.map((pluginName) => pluginMapping[pluginName]);
					const parseInput = module ? input : "return " + input;
					const ast = parse(babel, parseInput);
					if (error) {
						test("error", () => {
							try {
								babel.transformFromAst(ast, parseInput, { presets, plugins: [[pluginUnderTest, {}]], compact: true })
								throw new Error("Expected error: " + error.toString());
							} catch (e) {
								expect(e.toString()).toEqual(expect.stringContaining(error));
							}
						});
						return;
					}
					const extractFunction = module ? extractOnlyUserCode : extractJustFunction;
					const result = babel.transformFromAst(types.cloneDeep(ast), parseInput, { presets, plugins: mappedPlugins.concat([[pluginUnderTest, { target: "es6" }]]), compact: true, ast: true });
					const strippedResult = extractFunction(babel, result);
					const inlinedResult = babel.transformFromAst(types.cloneDeep(ast), parseInput, { presets, plugins: mappedPlugins.concat([[pluginUnderTest, { inlineHelpers: true }]]), compact: true, ast: true });
					const inlinedAndStrippedResult = extractFunction(babel, inlinedResult);
					const hoistedResult = babel.transformFromAst(types.cloneDeep(ast), parseInput, { presets, plugins: mappedPlugins.concat([[pluginUnderTest, { hoist: true, minify: true }]]), compact: true, ast: true });
					const hoistedAndStrippedResult = extractFunction(babel, hoistedResult);
					writeOutput(`tests/${name}/output.js`, strippedResult);
					writeOutput(`tests/${name}/inlined.js`, inlinedAndStrippedResult, strippedResult);
					writeOutput(`tests/${name}/hoisted.js`, hoistedAndStrippedResult, strippedResult);
					let fn, rewrittenFn, inlinedFn, hoistedFn;
					try {
						fn = new Function(`/* ${name} original */${parseInput}`)
					} catch (e) {
					}
					if (checkSyntax) {
						describe("syntax", () => {
							test("normal", () => {
								const code = result.code;
								try {
									rewrittenFn = new Function(`/* ${name} */${code}`);
								} catch (e) {
									if (e instanceof SyntaxError) {
										e.message += "\n" + code;
									}
									throw e;
								}
							});
							test("inlined", () => {
								const code = inlinedResult.code;
								try {
									inlinedFn = new Function(`/* ${name} inlined */${code}`);
								} catch (e) {
									if (e instanceof SyntaxError) {
										e.message += "\n" + code;
									}
									throw e;
								}
							});
							test("hoisted", () => {
								const code = hoistedResult.code;
								try {
									hoistedFn = new Function(`/* ${name} hoisted */${code}`);
								} catch (e) {
									if (e instanceof SyntaxError) {
										e.message += "\n" + code;
									}
									throw e;
								}
							});
						});
					}
					if (checkOutputMatches) {
						if (typeof output !== "undefined") {
							describe("output", () => {
								test("normal", () => {
									expect(strippedResult).toBe(output);
								});
								test("inlined", () => {
									expect(inlinedAndStrippedResult).toBe(typeof inlined !== "undefined" ? inlined : output);
								});
								test("hoisted", () => {
									expect(hoistedAndStrippedResult).toBe(typeof hoisted !== "undefined" ? hoisted : output);
								});
							});
						}
					}
					if (checkTestCases) {
						for (let key of Object.getOwnPropertyNames(cases)) {
							describe(key, () => {
								if (fn) {
									test("original", () => {
										return cases[key](fn());
									});
								}
								test("normal", () => {
									if (rewrittenFn) {
										return cases[key](rewrittenFn());
									}
								});
								test("inlined", () => {
									if (inlinedFn) {
										return cases[key](inlinedFn());
									}
								});
								test("hoisted", () => {
									if (hoistedFn) {
										return cases[key](hoistedFn());
									}
								});
							});
						}
					}
				});
			}
		});
	}
}
