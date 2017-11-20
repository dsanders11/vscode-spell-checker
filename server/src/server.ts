// cSpell:ignore pycache

import {
    createConnection,
    TextDocuments, TextDocument,
    InitializeResult,
    InitializeParams,
} from 'vscode-languageserver';
import * as vscode from 'vscode-languageserver';
import { TextDocumentUri, TextDocumentUriLangId } from './vscode.workspaceFolders';
import { CancellationToken } from 'vscode-jsonrpc';
import * as Validator from './validator';
import * as Rx from 'rxjs/Rx';
import { onCodeActionHandler } from './codeActions';
import { Text } from 'cspell';

import * as CSpell from 'cspell';
import { CSpellUserSettings } from './cspellConfig';
import { getDefaultSettings } from 'cspell';
import * as Api from './api';
import { DocumentSettings, SettingsCspell } from './documentSettings';
import { LogLevel, log, logger, logError, setWorkspaceFolders, setWorkspaceBase } from './core';

log('Starting Server');

const methodNames: Api.RequestMethodConstants = {
    isSpellCheckEnabled: 'isSpellCheckEnabled',
    getConfigurationForDocument: 'getConfigurationForDocument',
    splitTextIntoWords: 'splitTextIntoWords',
};

const notifyMethodNames: Api.NotifyServerMethodConstants = {
    onConfigChange: 'onConfigChange',
    registerConfigurationFile: 'registerConfigurationFile',
};

const tds = CSpell;

const defaultCheckLimit = Validator.defaultCheckLimit;

// Turn off the spell checker by default. The setting files should have it set.
// This prevents the spell checker from running too soon.
const defaultSettings: CSpellUserSettings = {
    ...CSpell.mergeSettings(getDefaultSettings(), CSpell.getGlobalSettings()),
    checkLimit: defaultCheckLimit,
    enabled: false,
};
const defaultDebounce = 50;
let activeSettingsNeedUpdating = false;

const configsToImport = new Set<string>();

function run() {
    // debounce buffer
    const validationRequestStream = new Rx.ReplaySubject<TextDocument>(1);
    const validationFinishedStream = new Rx.ReplaySubject<{ uri: string; version: number }>(1);
    const triggerUpdateConfig = new Rx.ReplaySubject<void>(1);
    const triggerValidateAll = new Rx.ReplaySubject<void>(1);

    // Create a connection for the server. The connection uses Node's IPC as a transport
    log('Create Connection');
    const connection = createConnection(vscode.ProposedFeatures.all);

    const documentSettings = new DocumentSettings(connection, defaultSettings);

    // Create a simple text document manager. The text document manager
    // supports full document sync only
    const documents: TextDocuments = new TextDocuments();

    connection.onInitialize((params: InitializeParams, token: CancellationToken): InitializeResult => {
        // Hook up the logger to the connection.
        log('onInitialize');
        setWorkspaceBase(params.rootUri ? params.rootUri : '');
        return {
            capabilities: {
                // Tell the client that the server works in FULL text document sync mode
                textDocumentSync: documents.syncKind,
                codeActionProvider: true
            }
        };
    });

    // The settings have changed. Is sent on server activation as well.
    connection.onDidChangeConfiguration(onConfigChange);

    interface OnChangeParam { settings: SettingsCspell; }
    function onConfigChange(change: OnChangeParam) {
        log('onConfigChange');
        triggerUpdateConfig.next(undefined);
    }

    function updateActiveSettings() {
        log('updateActiveSettings');
        documentSettings.resetSettings();
        activeSettingsNeedUpdating = false;
        triggerValidateAll.next(undefined);
    }

    function getActiveSettings(doc: TextDocumentUri) {
        return getActiveUriSettings(doc.uri);
    }

    function getActiveUriSettings(uri?: string) {
        if (activeSettingsNeedUpdating) {
            updateActiveSettings();
        }
        return documentSettings.getUriSettings(uri);
    }

    function registerConfigurationFile(path: string) {
        configsToImport.add(path);
        log('Load:', path);
        triggerUpdateConfig.next(undefined);
    }

    interface TextDocumentInfo {
        uri?: string;
        languageId?: string;
        text?: string;
    }

    // Listen for event messages from the client.
    connection.onNotification(notifyMethodNames.onConfigChange, onConfigChange);
    connection.onNotification(notifyMethodNames.registerConfigurationFile, registerConfigurationFile);

    connection.onRequest(methodNames.isSpellCheckEnabled, async (params: TextDocumentInfo): Promise<Api.IsSpellCheckEnabledResult> => {
        const { uri, languageId } = params;
        const fileEnabled = uri ? !await isUriExcluded(uri) : undefined;
        return {
            languageEnabled: languageId && uri ? await isLanguageEnabled({ uri, languageId }) : undefined,
            fileEnabled,
        };
    });

    connection.onRequest(methodNames.getConfigurationForDocument, async (params: TextDocumentInfo): Promise<Api.GetConfigurationForDocumentResult> => {
        const { uri, languageId } = params;
        const doc = uri && documents.get(uri);
        const docSettings = doc && await getSettingsToUseForDocument(doc) || undefined;
        const settings = await getActiveUriSettings(uri);
        return {
            languageEnabled: languageId && doc ? await isLanguageEnabled(doc) : undefined,
            fileEnabled: uri ? !await isUriExcluded(uri) : undefined,
            settings,
            docSettings,
        };
    });

    function textToWords(text: string): string[] {
        const setOfWords = new Set(
            Text.extractWordsFromCode(text)
                .map(t => t.text)
                .map(t => t.toLowerCase())
            );
        return [...setOfWords];
    }

    connection.onRequest(methodNames.splitTextIntoWords, (text: string): Api.SplitTextIntoWordsResult => {
        return {
            words: textToWords(text),
        };
    });

    interface DocSettingPair {
        doc: TextDocument;
        settings: CSpellUserSettings;
    }

    // validate documents
    const mapRequestTimersByUri = new Map<string, Rx.Observable<number>>();
    const mapTimersByUri = new Map<string, Rx.Observable<number>>();
    const disposeValidationStream = validationRequestStream
        .do(doc => log('Request Validate:', doc.uri))
        .debounce(doc => {
            if (!mapRequestTimersByUri.get(doc.uri)) {
                mapRequestTimersByUri.set(doc.uri, Rx.Observable.timer(50));
            }
            return mapRequestTimersByUri.get(doc.uri)!;
        })
        .do(doc => log('Request Validate 2:', doc.uri))
        .flatMap(async doc => ({ doc, settings: await getActiveSettings(doc)}) as DocSettingPair )
        .flatMap(async dsp => await shouldValidateDocument(dsp.doc) ? dsp : undefined)
        .filter(dsp => !!dsp)
        .map(dsp => dsp!)
        .debounce(dsp => {
            const { doc, settings } = dsp;
            if (!mapTimersByUri.get(doc.uri)) {
                mapTimersByUri.set(doc.uri, Rx.Observable.timer(settings.spellCheckDelayMs || defaultDebounce));
            }
            return mapTimersByUri.get(doc.uri)!;
        })
        .map(dsp => dsp.doc)
        .do(doc => log('Validate:', doc.uri))
        .subscribe(validateTextDocument);
    disposeValidationStream.add(() => mapRequestTimersByUri.clear());
    disposeValidationStream.add(() => mapTimersByUri.clear());

    // Clear the diagnostics for documents we do not want to validate
    const disposableSkipValidationStream = validationRequestStream
        .filter(doc => !shouldValidateDocument(doc))
        .do(doc => log('Skip Validate:', doc.uri))
        .subscribe(doc => {
            connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
        });

    const disposableTriggerUpdateConfigStream = triggerUpdateConfig
        .do(() => log('Trigger Update Config'))
        .do(() => activeSettingsNeedUpdating = true)
        .debounceTime(100)
        .subscribe(() => {
            updateActiveSettings();
        });

    const disposableTriggerValidateAll = triggerValidateAll
        .debounceTime(250)
        .subscribe(() => {
            log('Validate all documents');
            documents.all().forEach(doc => validationRequestStream.next(doc));
        });

    validationFinishedStream.next({ uri: 'start', version: 0 });

    async function shouldValidateDocument(textDocument: TextDocument): Promise<boolean> {
        const { uri } = textDocument;
        const settings = await getActiveSettings(textDocument);
        return !!settings.enabled && await isLanguageEnabled(textDocument)
            && !await isUriExcluded(uri);
    }

    async function isLanguageEnabled(textDocument: TextDocumentUriLangId) {
        const { enabledLanguageIds = []} = await getActiveSettings(textDocument);
        return enabledLanguageIds.indexOf(textDocument.languageId) >= 0;
    }

    async function isUriExcluded(uri: string) {
        return documentSettings.isExcluded(uri);
    }

    async function getBaseSettings(doc: TextDocument) {
        const settings = await getActiveSettings(doc);
        return {...CSpell.mergeSettings(defaultSettings, settings), enabledLanguageIds: settings.enabledLanguageIds};
    }

    async function getSettingsToUseForDocument(doc: TextDocument) {
        return tds.constructSettingsForText(await getBaseSettings(doc), doc.getText(), doc.languageId);
    }

    async function validateTextDocument(textDocument: TextDocument): Promise<void> {
        try {
            const settingsToUse = await getSettingsToUseForDocument(textDocument);
            if (settingsToUse.enabled) {
                Validator.validateTextDocument(textDocument, settingsToUse).then(diagnostics => {
                    log('validateTextDocument done:', textDocument.uri);
                    // Send the computed diagnostics to VSCode.
                    validationFinishedStream.next(textDocument);
                    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
                });
            }
        } catch (e) {
            logError(`validateTextDocument: ${JSON.stringify(e)}`);
        }
    }

    // Make the text document manager listen on the connection
    // for open, change and close text document events
    documents.listen(connection);

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    documents.onDidChangeContent((change) => {
        validationRequestStream.next(change.document);
    });

    documents.onDidClose((event) => {
        // A text document was closed we clear the diagnostics
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    });

    connection.onCodeAction(onCodeActionHandler(documents, getBaseSettings));

    // Listen on the connection
    connection.listen();

    // Free up the validation streams on shutdown.
    connection.onShutdown(() => {
        disposableSkipValidationStream.unsubscribe();
        disposeValidationStream.unsubscribe();
        disposableTriggerUpdateConfigStream.unsubscribe();
        disposableTriggerValidateAll.unsubscribe();
    });

    connection.workspace.getConfiguration({ section: 'cSpell.debugLevel',  }).then(
        (result: string) => {
            fetchFolders();
            logger.level = result;
            logger.setConnection(connection);
        },
        (reject) => {
            fetchFolders();
            logger.level = LogLevel.DEBUG;
            logger.error(`Filed to get config: ${JSON.stringify(reject)}`);
            logger.setConnection(connection);
        }
    );

    async function fetchFolders() {
        const folders = await connection.workspace.getWorkspaceFolders();
        if (folders) {
            setWorkspaceFolders(folders.map(f => f.uri));
        } else {
            setWorkspaceFolders([]);
        }
    }
}

run();