import { basename } from 'path';
import { ExecException } from 'child_process';
import { CancellationToken, CodeLens, CodeLensProvider, Event, EventEmitter, Position, Range, Selection, TextDocument, Uri, window, workspace } from 'vscode';
import Maintainability from './Maintainability';

import * as radon from './Radon';
import Rating from './Rating';
import SourcecodeInformation from './SourcecodeInformation';

let TERMINAL_ID = 1;

function capitalize(text: string) {
    if (!text) { return text; }
    return text[0].toUpperCase() + text.substring(1);
}

export default class RadonProvider implements CodeLensProvider {

    private codeLenses: CodeLens[] = [];
    private _onDidChangeCodeLenses: EventEmitter<void> = new EventEmitter<void>();
    private sourcecodeInformations: { [key: string]: SourcecodeInformation } = {};
    private maintainabilities: { [key: string]: Maintainability } = {};
    private ratings: { [key: string]: Rating[] } = {};
    private currentVersion: number[] | null = null;
    public readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;


    constructor() {
        this.registerHandler();
        if (window.activeTextEditor) {
            this.retrieveData(window.activeTextEditor.document);
        }
    }

    private registerHandler() {
        workspace.onDidChangeTextDocument(e => {
            this.ratings[e.document.fileName] = [];
            this._onDidChangeCodeLenses.fire();
        });
        workspace.onDidOpenTextDocument(e => this.retrieveData(e));
        workspace.onDidSaveTextDocument(e => this.retrieveData(e));
        window.onDidChangeActiveTextEditor(e => e && this.retrieveData(e.document));

        workspace.onDidCloseTextDocument(event => {
            delete this.maintainabilities[event.fileName];
            delete this.ratings[event.fileName];
        });
    }

    private retrieveData(document: TextDocument) {
        console.log("Retrieve data");
        try {
            let check;
            if (this.currentVersion === null) {
                check = radon.getVersion();
            } else {
                check = Promise.resolve(this.currentVersion);
            }
            check.then(version => {
                console.log("Version", version);
                const [major, minor] = version;
                if (major < 5 || minor < 1) {
                    throw new UnsupportedVersionException("You need at least python radon version 5.1 installed. Try pip install \"radon>=5.1\".");
                }
                this.currentVersion = version;
                console.log("Checked", version);
                return Promise.all([
                    radon.calculateCyclomaticComplexity(document.fileName),
                    radon.calculateMaintainablityIndex(document.fileName),
                    radon.calculateSourcecodeInformation(document.fileName)]);
            }).then(([ratings, maintainability, sourcecodeInformation]) => {
                console.log("Firing", document.fileName);
                this.sourcecodeInformations[document.fileName] = sourcecodeInformation;
                this.maintainabilities[document.fileName] = maintainability;
                this.ratings[document.fileName] = ratings.map(rating => {
                    const { lineno, character } = rating;
                    const position = new Position(lineno - 1, character);
                    const range = document.getWordRangeAtPosition(position);
                    if (range) {
                        rating.range = range;
                    }
                    return rating;
                }).filter(rating => !!rating.range);
                this._onDidChangeCodeLenses.fire();
                console.log("Fired", document.fileName);
            }).catch((err) => {
                // if (err instanceof UnsupportedVersionException || (err.message && err.message.startsWith("Command failed"))) {
                    window.showInformationMessage(err.message, ...["Install Radon"])
                        .then(selection => {
                            if (selection === "Install Radon") {
                                const terminal = window.createTerminal(`Install Radon ${TERMINAL_ID++}`);
                                terminal.show(true);
                                terminal.sendText("pip install --user \"radon>=5.1\"", true);
                            }
                        });
                    return;
                // }
                // console.error(err);
                // window.showErrorMessage(err.message);
            });
        } catch (err) {
            console.error(err);
        }
    }

    private createRatingCodeLens(rating: Rating): CodeLens {
        const { name, type, complexity, rank, range } = rating;
        const risk = getRiskMessage(rank);
        const message = `${capitalize(type)} "${name}" is rated ${rank} by a complexity of ${complexity}. The risk is ${risk}`;
        return new CodeLens(range, {
            title: message,
            tooltip: message,
            command: ""
        });
    }

    private createMaintainabilityCodeLens(range: Range, filename: string, maintainability: Maintainability,
        sourcecodeInformation: SourcecodeInformation): CodeLens {
        const { index, rank } = maintainability;
        const { loc, lloc, sloc, comments, blank, multi, singleComments } = sourcecodeInformation;
        const rangeInformation = getRangeInformation(rank);
        const sourcecodeSummary = getSourcecodeInformation(sourcecodeInformation);
        const message = `${basename(filename)} is rated ${rank} with a maintainability index of ${index.toFixed(2)} ${rangeInformation}`;
        return new CodeLens(range, {
            title: message,
            tooltip: `${message}\n\n${sourcecodeSummary}`,
            command: ""
        });
    }

    public provideCodeLenses(document: TextDocument, token: CancellationToken): CodeLens[] | Thenable<CodeLens[]> {

        if (workspace.getConfiguration("python.radon").get("enable", true)) {
            this.codeLenses = [];
            try {
                if (this.ratings[document.fileName]
                    && this.ratings[document.fileName].length > 0) {
                    this.codeLenses = this.ratings[document.fileName].map(this.createRatingCodeLens);
                }
                let range = null;
                if (this.maintainabilities[document.fileName]
                    && (range = document.getWordRangeAtPosition(new Position(0, 0))) !== undefined) {
                    this.codeLenses.push(this.createMaintainabilityCodeLens(range, document.fileName,
                        this.maintainabilities[document.fileName], this.sourcecodeInformations[document.fileName]));
                }
            } catch (err) {
                console.error(err);
            }
            console.log("CL", this.codeLenses);
            return this.codeLenses;
        }
        return [];
    }

    public resolveCodeLens(codeLens: CodeLens, token: CancellationToken) {
        if (workspace.getConfiguration("python.radon").get("enable", true)) {
            return codeLens;
        }
        return null;
    }
}

function getSourcecodeInformation({ loc, lloc, sloc, comments, blank, multi }: SourcecodeInformation): string {
    return `Lines of code: ${loc}
Logical lines of code: ${lloc}
Source lines of code: ${sloc}
Amount of single line comments: ${comments}
Amount of multi line strings: ${multi}
Number of blank lines: ${blank}`;
}

function getRangeInformation(rank: string): string {
    switch (rank) {
        case "B":
            return "(19-10, medium)";
            break;
        case "C":
            return "(9-0, extremely low)";
            break;
        default:
            return "(100-20 = very high)";
    }
}

function getRiskMessage(rank: string): string {
    switch (rank) {
        case "A":
            return "low - simple block";
        case "B":
            return "low - well structured and stable block";
        case "C":
            return "moderate - slightly complex block";
        case "D":
            return "more than moderate - more complex block";
        case "E":
            return "high - complex block, alarming";
        default:
            return "very high - error - prone, unstable block";
    }
}
