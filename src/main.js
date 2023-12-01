//@ts-check

var lang = require("./lang.js");
var SYSTEM_PROMPT = require("./const.js").SYSTEM_PROMPT;

var buildHeader = require("./utils.js").buildHeader;
var ensureHttpsAndNoTrailingSlash = require("./utils.js").ensureHttpsAndNoTrailingSlash;
var getApiKey = require("./utils.js").getApiKey;
var handleError = require("./utils.js").handleError;
var handleValidateError = require("./utils.js").handleValidateError;
var replacePromptKeywords = require("./utils.js").replacePromptKeywords;

/**
 * @param {Bob.TranslateQuery} query
 * @returns {{ 
 *  generatedSystemPrompt: string, 
 *  generatedUserPrompt: string 
 * }}
*/
function generatePrompts(query) {
    let generatedSystemPrompt = SYSTEM_PROMPT;
    const { detectFrom, detectTo } = query;
    const sourceLang = lang.langMap.get(detectFrom) || detectFrom;
    const targetLang = lang.langMap.get(detectTo) || detectTo;
    let generatedUserPrompt = `translate from ${sourceLang} to ${targetLang}`;

    if (detectTo === "wyw" || detectTo === "yue") {
        generatedUserPrompt = `翻译成${targetLang}`;
    }

    if (
        detectFrom === "wyw" ||
        detectFrom === "zh-Hans" ||
        detectFrom === "zh-Hant"
    ) {
        if (detectTo === "zh-Hant") {
            generatedUserPrompt = "翻译成繁体白话文";
        } else if (detectTo === "zh-Hans") {
            generatedUserPrompt = "翻译成简体白话文";
        } else if (detectTo === "yue") {
            generatedUserPrompt = "翻译成粤语白话文";
        }
    }
    if (detectFrom === detectTo) {
        generatedSystemPrompt =
            "You are a text embellisher, you can only embellish the text, don't interpret it.";
        if (detectTo === "zh-Hant" || detectTo === "zh-Hans") {
            generatedUserPrompt = "润色此句";
        } else {
            generatedUserPrompt = "polish this sentence";
        }
    }

    generatedUserPrompt = `${generatedUserPrompt}:\n\n${query.text}`

    return { generatedSystemPrompt, generatedUserPrompt };
}

/**
 * @param {string} model
 * @param {Bob.TranslateQuery} query
 * @returns {{ 
 *  model: string;
 *  temperature: number;
 *  max_tokens: number;
 *  top_p: number;
 *  frequency_penalty: number;
 *  presence_penalty: number;
 *  messages?: {
 *    role: "system" | "user";
 *    content: string;
 *  }[];
 *  prompt?: string;
 * }}
*/
function buildRequestBody(model, query) {
    let { customSystemPrompt, customUserPrompt } = $option;
    const { generatedSystemPrompt, generatedUserPrompt } = generatePrompts(query);

    customSystemPrompt = replacePromptKeywords(customSystemPrompt, query);
    customUserPrompt = replacePromptKeywords(customUserPrompt, query);

    const systemPrompt = customSystemPrompt || generatedSystemPrompt;
    const userPrompt = customUserPrompt || generatedUserPrompt;

    const standardBody = {
        model: model,
        stream: true,
        temperature: 0.2,
        max_tokens: 1000,
        top_p: 1,
        frequency_penalty: 1,
        presence_penalty: 1,
    };

    return {
        ...standardBody,
        model: model,
        messages: [
            {
                role: "system",
                content: systemPrompt,
            },
            {
                role: "user",
                content: userPrompt,
            },
        ],
    };
}

/**
 * @param {Bob.TranslateQuery} query
 * @param {string} targetText
 * @param {string} textFromResponse
 * @returns {string}
*/
function handleResponse(query, targetText, textFromResponse) {
    if (textFromResponse !== '[DONE]') {
        try {
            const dataObj = JSON.parse(textFromResponse);
            // https://github.com/openai/openai-node/blob/master/src/resources/chat/completions.ts#L190
            const { choices } = dataObj;
            const delta = choices[0]?.delta?.content;
            if (delta) {
                targetText += delta;
                query.onStream({
                    result: {
                        from: query.detectFrom,
                        to: query.detectTo,
                        toParagraphs: [targetText],
                    },
                });
            }
        } catch (err) {
            handleError(query, {
                type: err.type || "param",
                message: err.message || "Failed to parse JSON",
                addition: err.addition,
            });
        }
    }
    return targetText;
}

/**
 * @type {Bob.Translate}
 */
function translate(query) {
    if (!lang.langMap.get(query.detectTo)) {
        handleError(query, {
            type: "unsupportLanguage",
            message: "不支持该语种",
            addition: "不支持该语种",
        });
    }

    const { model, customModel, apiKeys, apiVersion, apiUrl, deploymentName } = $option;

    const isCustomModelRequired = model === "custom";
    if (isCustomModelRequired && !customModel) {
        handleError(query, {
            type: "param",
            message: "配置错误 - 请确保您在插件配置中填入了正确的自定义模型名称",
            addition: "请在插件配置中填写自定义模型名称",
        });
    }

    if (!apiKeys) {
        handleError(query, {
            type: "secretKey",
            message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
            addition: "请在插件配置中填写 API Keys",
        });
    }

    const modelValue = isCustomModelRequired ? customModel : model;

    const apiKey = getApiKey($option.apiKeys);

    const baseUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://api.openai.com");
    let apiUrlPath = baseUrl.includes("gateway.ai.cloudflare.com") ? "/chat/completions" : "/v1/chat/completions";
    const apiVersionQuery = apiVersion ? `?api-version=${apiVersion}` : "?api-version=2023-03-15-preview";
    
    const isAzureServiceProvider = baseUrl.includes("openai.azure.com");
    if (isAzureServiceProvider) {
        if (deploymentName) {
            apiUrlPath = `/openai/deployments/${deploymentName}/chat/completions${apiVersionQuery}`;
        } else {
            handleError(query,{
                type: "secretKey",
                message: "配置错误 - 未填写 Deployment Name",
                addition: "请在插件配置中填写 Deployment Name",
                troubleshootingLink: "https://bobtranslate.com/service/translate/azureopenai.html"
            });
        } 
    }

    const header = buildHeader(isAzureServiceProvider, apiKey);
    const body = buildRequestBody(modelValue, query);
    

    let targetText = ""; // 初始化拼接结果变量
    let buffer = ""; // 新增 buffer 变量
    (async () => {
        await $http.streamRequest({
            method: "POST",
            url: baseUrl + apiUrlPath,
            header,
            body,
            cancelSignal: query.cancelSignal,
            streamHandler: (streamData) => {
                if (streamData.text?.includes("Invalid token")) {
                    handleError(query, {
                        type: "secretKey",
                        message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
                        addition: "请在插件配置中填写正确的 API Keys",
                        troubleshootingLink: "https://bobtranslate.com/service/translate/openai.html"
                    });
                } else if (streamData.text !== undefined) {
                    // 将新的数据添加到缓冲变量中
                    buffer += streamData.text;
                    // 检查缓冲变量是否包含一个完整的消息
                    while (true) {
                        const match = buffer.match(/data: (.*?})\n/);
                        if (match) {
                            // 如果是一个完整的消息，处理它并从缓冲变量中移除
                            const textFromResponse = match[1].trim();
                            targetText = handleResponse(query, targetText, textFromResponse);
                            buffer = buffer.slice(match[0].length);
                        } else {
                            // 如果没有完整的消息，等待更多的数据
                            break;
                        }
                    }
                }
            },
            handler: (result) => {
                if (result.response.statusCode >= 400) {
                    handleError(query, result);
                } else {
                    query.onCompletion({
                        result: {
                            from: query.detectFrom,
                            to: query.detectTo,
                            toParagraphs: [targetText],
                        },
                    });
                }
            }
        });
    })().catch((err) => {
        handleError(query, err);
    });
}

function supportLanguages() {
    return lang.supportLanguages.map(([standardLang]) => standardLang);
}


/**
 * @type {Bob.PluginValidate}
 */
function pluginValidate(completion) {
    const { apiKeys, apiUrl, deploymentName } = $option;
    if (!apiKeys) {
        handleValidateError(completion, {
            type: "secretKey",
            message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
            addition: "请在插件配置中填写正确的 API Keys",
            troubleshootingLink: "https://bobtranslate.com/service/translate/openai.html"
        });
        return;
    }

    const apiKey = getApiKey(apiKeys);

    const baseUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://api.openai.com");
    let apiUrlPath = baseUrl.includes("gateway.ai.cloudflare.com") ? "/models" : "/v1/models";

    const isAzureServiceProvider = apiUrl.includes("openai.azure.com");
    if (isAzureServiceProvider && !deploymentName) {
        handleValidateError(completion, {
            type: "secretKey",
            message: "配置错误 - 未填写 Deployment Name",
            addition: "请在插件配置中填写 Deployment Name",
            troubleshootingLink: "https://bobtranslate.com/service/translate/azureopenai.html"
        });
        return;
    }

    const header = buildHeader(isAzureServiceProvider, apiKey);
    (async () => {
        $http.request({
            method: "GET",
            url: baseUrl+apiUrlPath,
            header: header,
            handler: function(resp) {
                if (resp.data.error) {
                    const { statusCode } = resp.response;
                    const reason = (statusCode >= 400 && statusCode < 500) ? "param" : "api";
                    handleValidateError(completion, {
                        type: reason,
                        message: resp.data.error,
                        troubleshootingLink: "https://bobtranslate.com/service/translate/openai.html"
                    });
                    return;
                }
                const modelList = resp.data
                if (modelList.data?.length > 0) {
                    completion({
                        result: true,
                    })
                }
            }
        });
    })().catch((err) => {
        handleValidateError(completion, err);
    });
}

function pluginTimeoutInterval() {
    return 60;
}

exports.pluginTimeoutInterval = pluginTimeoutInterval;
exports.pluginValidate = pluginValidate;
exports.supportLanguages = supportLanguages;
exports.translate = translate;