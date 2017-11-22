/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

// Provides some extra commands on top of base Lsp.
import type {CodeAction} from 'atom-ide-ui';
import type {
  TextEdit,
  Command,
} from '../../nuclide-vscode-language-service-rpc/lib/protocol';

import {
  lspUri_localPath,
  lspTextEdits_atomTextEdits,
} from '../../nuclide-vscode-language-service-rpc/lib/convert';
import {LspLanguageService} from '../../nuclide-vscode-language-service-rpc/lib/LspLanguageService';

type CqueryProgressNotification = {
  indexRequestCount: number,
  doIdMapCount: number,
  loadPreviousIndexCount: number,
  onIdMappedCount: number,
  onIndexedCount: number,
};

// FIXME pelmers: tracking cquery/issues/30
// https://github.com/jacobdufault/cquery/issues/30#issuecomment-345536318
function shortenByOneCharacter({newText, range}: TextEdit): TextEdit {
  return {
    newText,
    range: {
      start: range.start,
      end: {line: range.end.line, character: range.end.character - 1},
    },
  };
}

export class CqueryLanguageClient extends LspLanguageService {
  start(): Promise<void> {
    // Workaround for https://github.com/babel/babel/issues/3930
    return super.start().then(() => this.startCquery());
  }

  async startCquery(): Promise<void> {
    this._lspConnection._jsonRpcConnection.onNotification(
      {method: '$cquery/progress'},
      (args: CqueryProgressNotification) => {
        const {
          indexRequestCount,
          doIdMapCount,
          loadPreviousIndexCount,
          onIdMappedCount,
          onIndexedCount,
        } = args;
        const total =
          indexRequestCount +
          doIdMapCount +
          loadPreviousIndexCount +
          onIdMappedCount +
          onIndexedCount;
        if (total === 0) {
          this._handleProgressNotification({
            id: 'cquery-progress',
            label: null,
          });
        } else {
          const label = `cquery: ${total} jobs`;
          this._handleProgressNotification({id: 'cquery-progress', label});
        }
      },
    );
    // TODO pelmers Register handlers for other custom cquery messages.
    // TODO pelmers hook into refactorizer for renaming?
  }

  _executeCommand(command: string, args?: Array<any>): Promise<void> {
    const cqueryEditCommands = new Set(['cquery._applyFixIt']);
    if (cqueryEditCommands.has(command) && args != null && args.length === 2) {
      return this._applyEdit(...args).then(result =>
        this._notifyOnFail(result, 'Cquery: apply edit failed'),
      );
    } else {
      return super._executeCommand(command, args);
    }
    // TODO pelmers: handle cquery._autoImplement
  }

  _convertCommands_CodeActions(commands: Array<Command>): Array<CodeAction> {
    // Find 'cquery._insertInclude' commands and deduplicate/expand them.
    // If there is one edit then the message is 'Insert #include <header>',
    // Otherwise the message is 'Pick one of $x includes' and we ask for choice.
    const outputCommands = [];
    const seenIncludes = new Set();
    for (const command of commands) {
      if (command.command !== 'cquery._insertInclude') {
        outputCommands.push(command);
      } else if (command.arguments != null && command.arguments.length === 2) {
        const file: string = command.arguments[0];
        const edits: Array<TextEdit> = command.arguments[1];
        // Split each edit into its own command.
        for (const edit of edits) {
          const includeValue = edit.newText;
          if (!seenIncludes.has(includeValue)) {
            seenIncludes.add(includeValue);
            outputCommands.push({
              command: 'cquery._applyFixIt',
              title: 'Insert ' + includeValue,
              arguments: [file, [edit]],
            });
          }
        }
      }
    }
    return super._convertCommands_CodeActions(outputCommands);
  }

  async _notifyOnFail(success: boolean, falseMessage: string): Promise<void> {
    if (!success) {
      return this._host
        .dialogNotification('warning', falseMessage)
        .refCount()
        .toPromise();
    }
  }

  // TODO pelmers: remove this when cquery implements workspace/applyEdit
  async _applyEdit(file: string, edits: Array<TextEdit>): Promise<boolean> {
    return this._host.applyTextEditsForMultipleFiles(
      new Map([
        [
          lspUri_localPath(file),
          lspTextEdits_atomTextEdits(edits.map(shortenByOneCharacter)),
        ],
      ]),
    );
  }
}
