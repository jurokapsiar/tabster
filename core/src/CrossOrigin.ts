/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { DeloserAPI, DeloserHistoryByRootBase, DeloserItemBase } from './Deloser';
import { getAbilityHelpersOnElement } from './Instance';
import { KeyboardNavigationState } from './State/KeyboardNavigation';
import { RootAPI } from './Root';
import { Subscribable } from './State/Subscribable';
import * as Types from './Types';
import { elementByUId, getElementUId, getUId, getWindowUId, HTMLElementWithUID, WindowWithUID } from './Utils';

const _transactionTimeout = 1500;
const _pingTimeout = 3000;

const _targetIdUp = 'up';

let _ignoreKeyboardNavigationStateUpdate = false;
let _focusOwner: string | undefined;
let _focusOwnerTimestamp: number | undefined;
const _deloserByUId: { [uid: string]: Types.Deloser } = {};

let _origOutlineSetup: ((props?: Partial<Types.OutlineProps>) => void) | undefined;

interface KnownTargets {
    [id: string]: {
        send: (payload: Types.CrossOriginTransactionData<any, any>) => void;
        last?: number;
    };
}

class CrossOriginDeloserItem extends DeloserItemBase<CrossOriginDeloser> {
    private _deloser: CrossOriginDeloser;
    private _transactions: CrossOriginTransactions;

    constructor(ah: Types.AbilityHelpers, deloser: CrossOriginDeloser, trasactions: CrossOriginTransactions) {
        super();
        this._deloser = deloser;
        this._transactions = trasactions;
    }

    belongsTo(deloser: CrossOriginDeloser): boolean {
        return deloser.deloserUId === this._deloser.deloserUId;
    }

    async focusAvailable(): Promise<boolean> {
        const data: RestoreFocusInDeloserTransactionData = {
            ...this._deloser,
            reset: false
        };

        return this._transactions.beginTransaction(RestoreFocusInDeloserTransaction, data).then(value => !!value);
    }

    async resetFocus(): Promise<boolean> {
        const data: RestoreFocusInDeloserTransactionData = {
            ...this._deloser,
            reset: true
        };

        return this._transactions.beginTransaction(RestoreFocusInDeloserTransaction, data).then(value => !!value);
    }
}

class CrossOriginDeloserHistoryByRoot extends DeloserHistoryByRootBase<CrossOriginDeloser, CrossOriginDeloserItem> {
    private _transactions: CrossOriginTransactions;

    constructor(
        ah: Types.AbilityHelpers,
        rootUId: string,
        transactions: CrossOriginTransactions
    ) {
        super(ah, rootUId);
        this._transactions = transactions;
    }

    unshift(deloser: CrossOriginDeloser): void {
        let item: CrossOriginDeloserItem | undefined;

        for (let i = 0; i < this._history.length; i++) {
            if (this._history[i].belongsTo(deloser)) {
                item = this._history[i];
                this._history.splice(i, 1);
                break;
            }
        }

        if (!item) {
            item = new CrossOriginDeloserItem(this._ah, deloser, this._transactions);
        }

        this._history.unshift(item);

        this._history.splice(10, this._history.length - 10);
    }

    async focusAvailable(): Promise<boolean> {
        for (const i of this._history) {
            if (await i.focusAvailable()) {
                return true;
            }
        }

        return false;
    }

    async resetFocus(): Promise<boolean> {
        for (const i of this._history) {
            if (await i.resetFocus()) {
                return true;
            }
        }

        return false;
    }
}

abstract class CrossOriginTransaction<I, O> {
    abstract type: Types.CrossOriginTransactionType;
    readonly id: string;
    readonly beginData: I;
    readonly timeout?: number;
    protected ah: Types.AbilityHelpers;
    protected endData: O | undefined;
    protected owner: Window;
    protected ownerId: string;
    protected sendUp: Types.CrossOriginTransactionSend | undefined;
    private _promise: Promise<O>;
    protected _resolve: ((endData?: O) => void) | undefined;
    private _reject: ((reason: string) => void) | undefined;
    private _knownTargets: KnownTargets;
    private _sentTo: Types.CrossOriginSentTo;
    protected targetId: string | undefined;
    private _inProgress: { [id: string]: boolean } = {};
    private _isDone = false;
    private _isSelfResponding = false;
    private _sentCount = 0;

    constructor(
        ah: Types.AbilityHelpers,
        owner: WindowWithUID,
        knownTargets: KnownTargets,
        value: I,
        timeout?: number,
        sentTo?: Types.CrossOriginSentTo,
        targetId?: string,
        sendUp?: Types.CrossOriginTransactionSend
    ) {
        this.ah = ah;
        this.owner = owner;
        this.ownerId = getWindowUId(owner);
        this.id = getUId(owner);
        this.beginData = value;
        this._knownTargets = knownTargets;
        this._sentTo = sentTo || { [this.ownerId]: true };
        this.targetId = targetId;
        this.sendUp = sendUp;
        this.timeout = timeout;
        this._promise = new Promise<O>((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    protected getTargets(knownTargets: KnownTargets): KnownTargets | null {
        return this.targetId === _targetIdUp
            ? (this.sendUp
                ? { [_targetIdUp]: { send: this.sendUp } }
                : null)
            : (this.targetId
                ? (knownTargets[this.targetId]
                    ? { [this.targetId]: { send: knownTargets[this.targetId].send } }
                    : null)
                : (((Object.keys(knownTargets).length === 0) && (this.sendUp))
                    ? { [_targetIdUp]: { send: this.sendUp } }
                    : (Object.keys(knownTargets).length > 0
                        ? knownTargets
                        : null))
            );
    }

    begin(selfResponse?: (data: Types.CrossOriginTransactionData<I, O>) => Promise<O | undefined>): Promise<O | undefined> {
        const targets = this.getTargets(this._knownTargets);
        const sentTo: Types.CrossOriginSentTo = { ...this._sentTo };

        if (targets) {
            for (let id of Object.keys(targets)) {
                sentTo[id] = true;
            }
        }

        const data: Types.CrossOriginTransactionData<I, O> = {
            transaction: this.id,
            type: this.type,
            isResponse: false,
            timestamp: Date.now(),
            owner: this.ownerId,
            sentto: sentTo,
            timeout: this.timeout,
            beginData: this.beginData
        };

        if (this.targetId) {
            data.target = this.targetId;
        }

        if (selfResponse) {
            this._isSelfResponding = true;

            selfResponse(data).then(value => {
                this._isSelfResponding = false;

                if (value !== undefined) {
                    if (!this.endData) {
                        this.endData = value;
                    }
                }

                if (this.endData || (this._sentCount === 0)) {
                    this.end();
                }
            });
        }

        if (targets) {
            for (let id of Object.keys(targets)) {
                if (!(id in this._sentTo)) {
                    this._send(targets[id].send, id, data);
                }
            }
        }

        if ((this._sentCount === 0) && !this._isSelfResponding) {
            this.end();
        }

        return this._promise;
    }

    private _send(
        send: (data: Types.CrossOriginTransactionData<I, O>) => void,
        targetId: string,
        data: Types.CrossOriginTransactionData<I, O>
    ) {
        if (this._inProgress[targetId] === undefined) {
            this._inProgress[targetId] = true;
            this._sentCount++;
            send(data);
        }
    }

    end(error?: string): void {
        if (this._isDone) {
            return;
        }

        this._isDone = true;

        if ((this.endData === undefined) && error) {
            if (this._reject) {
                this._reject(error);
            }
        } else if (this._resolve) {
            this._resolve(this.endData);
        }
    }

    onResponse(data: Types.CrossOriginTransactionData<I, O>): void {
        const endData = data.endData;

        if ((endData !== undefined) && !this.endData) {
            this.endData = endData;
        }

        const inProgressId = (data.target === _targetIdUp) ? _targetIdUp : data.owner;

        if (this._inProgress[inProgressId]) {
            this._inProgress[inProgressId] = false;
            this._sentCount--;

            if (this.endData || ((this._sentCount === 0) && !this._isSelfResponding)) {
                this.end();
            }
        }
    }
}

interface CrossOriginTransactionClass<I, O> {
    new (
        ah: Types.AbilityHelpers,
        owner: WindowWithUID,
        knownTargets: KnownTargets,
        value: I,
        timeout?: number,
        sentTo?: Types.CrossOriginSentTo,
        targetId?: string,
        sendUp?: Types.CrossOriginTransactionSend
    ): CrossOriginTransaction<I, O>;
    shouldForward?(ah: Types.AbilityHelpers, data: Types.CrossOriginTransactionData<I, O>, owner: Window, ownerId: string): boolean;
    makeResponse(
        ah: Types.AbilityHelpers,
        data: Types.CrossOriginTransactionData<I, O>,
        owner: Window,
        ownerId: string,
        transactions: CrossOriginTransactions,
        forwardResult: Promise<O | undefined>,
        isSelfResponse?: boolean
    ): Promise<O>;
    shouldSelfRespond?(ah: Types.AbilityHelpers, data: I, owner: Window, ownerId: string): boolean;
}

interface BootstrapTransactionContents {
    isNavigatingWithKeyboard: boolean;
}

class BootstrapTransaction extends CrossOriginTransaction<undefined, BootstrapTransactionContents> {
    type = Types.CrossOriginTransactionType.Bootstrap;

    static shouldForward() {
        return false;
    }

    static async makeResponse(ah: Types.AbilityHelpers): Promise<BootstrapTransactionContents> {
        return { isNavigatingWithKeyboard: ah.keyboardNavigation.isNavigatingWithKeyboard() };
    }
}

interface CrossOriginElementDataIn {
    uid?: string;
    id?: string;
    rootId?: string;
    ownerId?: string;
    observedName?: string;
}

interface FocusElementData extends CrossOriginElementDataIn {
    noFocusedProgrammaticallyFlag?: boolean;
    noAccessibleCheck?: boolean;
}

class FocusElementTransaction extends CrossOriginTransaction<FocusElementData, boolean> {
    type = Types.CrossOriginTransactionType.FocusElement;

    static shouldSelfRespond = () => true;

    static shouldForward(
        ah: Types.AbilityHelpers,
        data: Types.CrossOriginTransactionData<FocusElementData, boolean>,
        owner: Window
    ): boolean {
        const el = GetElementTransaction.findElement(ah, owner, data.beginData);
        return !el || !ah.focusable.isFocusable(el);
    }

    static async makeResponse(
        ah: Types.AbilityHelpers,
        data: Types.CrossOriginTransactionData<FocusElementData, boolean>,
        owner: Window,
        ownerId: string,
        transactions: CrossOriginTransactions,
        forwardResult: Promise<boolean | undefined>
    ): Promise<boolean> {
        const el = GetElementTransaction.findElement(ah, owner, data.beginData);
        return (!!el && ah.focusedElement.focus(el)) || !!(await forwardResult);
    }
}

enum CrossOriginState {
    Focused = 1,
    Blurred = 2,
    Observed = 3,
    DeadWindow = 4,
    KeyboardNavigation = 5,
    Outline = 6
}

interface CrossOriginElementDataOut {
    ownerUId: string;
    uid?: string;
    id?: string;
    rootUId?: string;
    deloserUId?: string;
    observedName?: string;
    observedDetails?: string;
}

interface CrossOriginStateData extends CrossOriginElementDataOut {
    state: CrossOriginState;
    isFocusedProgrammatically?: boolean;
    force?: boolean;
    isNavigatingWithKeyboard?: boolean;
    outline?: Partial<Types.OutlineProps>;
}

class StateTransaction extends CrossOriginTransaction<CrossOriginStateData, true> {
    type = Types.CrossOriginTransactionType.State;

    static shouldSelfRespond(ah: Types.AbilityHelpers, data: CrossOriginStateData): boolean {
        return (data.state !== CrossOriginState.DeadWindow) && (data.state !== CrossOriginState.KeyboardNavigation);
    }

    static async makeResponse(
        ah: Types.AbilityHelpers,
        data: Types.CrossOriginTransactionData<CrossOriginStateData, true>,
        owner: Window,
        ownerId: string,
        transactions: CrossOriginTransactions,
        forwardResult: Promise<true | undefined>,
        isSelfResponse?: boolean
    ): Promise<true> {
        const timestamp = data.timestamp;
        const beginData = data.beginData;

        if (timestamp && beginData) {
            switch (beginData.state) {
                case CrossOriginState.Focused:
                    return StateTransaction._makeFocusedResponse(ah, timestamp, beginData, transactions, isSelfResponse);
                case CrossOriginState.Blurred:
                    return StateTransaction._makeBlurredResponse(ah, timestamp, beginData);
                case CrossOriginState.Observed:
                    return StateTransaction._makeObservedResponse(ah, beginData);
                case CrossOriginState.DeadWindow:
                    return StateTransaction._makeDeadWindowResponse(ah, beginData, transactions, forwardResult);
                case CrossOriginState.KeyboardNavigation:
                    return StateTransaction._makeKeyboardNavigationResponse(ah, beginData.isNavigatingWithKeyboard);
                case CrossOriginState.Outline:
                    return StateTransaction._makeOutlineResponse(ah, beginData.outline);
            }
        }

        return true;
    }

    static createElement(ah: Types.AbilityHelpers, beginData: CrossOriginElementDataOut): CrossOriginElement | null {
        return beginData.uid
            ? new CrossOriginElement(
                ah,
                beginData.uid,
                beginData.ownerUId,
                beginData.id,
                beginData.rootUId,
                beginData.observedName,
                beginData.observedDetails)
            : null;
    }

    private static async _makeFocusedResponse(
        ah: Types.AbilityHelpers,
        timestamp: number,
        beginData: CrossOriginStateData,
        transactions: CrossOriginTransactions,
        isSelfResponse?: boolean
    ): Promise<true> {
        const element = StateTransaction.createElement(ah, beginData);

        if (beginData && (beginData.ownerUId) && element) {
            _focusOwner = beginData.ownerUId;
            _focusOwnerTimestamp = timestamp;

            if (!isSelfResponse && beginData.rootUId && beginData.deloserUId) {
                const history = DeloserAPI.getHistory(ah.deloser);

                const deloser: CrossOriginDeloser = {
                    ownerUId: beginData.ownerUId,
                    deloserUId: beginData.deloserUId,
                    rootUId: beginData.rootUId
                };

                const historyItem = history.make(
                    beginData.rootUId,
                    () => new CrossOriginDeloserHistoryByRoot(ah, deloser.rootUId, transactions)
                );

                historyItem.unshift(deloser);
            }

            CrossOriginFocusedElementState.setVal(
                ah.crossOrigin.focusedElement,
                element,
                { isFocusedProgrammatically: beginData.isFocusedProgrammatically }
            );
        }

        return true;
    }

    private static async _makeBlurredResponse(
        ah: Types.AbilityHelpers,
        timestamp: number,
        beginData: CrossOriginStateData
    ): Promise<true> {
        if (
            beginData &&
            ((beginData.ownerUId === _focusOwner) || beginData.force) &&
            (!_focusOwnerTimestamp || (_focusOwnerTimestamp < timestamp))
        ) {
            CrossOriginFocusedElementState.setVal(ah.crossOrigin.focusedElement, undefined, {});
        }

        return true;
    }

    private static async _makeObservedResponse(
        ah: Types.AbilityHelpers,
        beginData: CrossOriginStateData
    ): Promise<true> {
        const name = beginData.observedName;
        const element = StateTransaction.createElement(ah, beginData);

        if (name && element) {
            CrossOriginObservedElementState.trigger(
                ah.crossOrigin.observedElement,
                element,
                { name, details: beginData.observedDetails }
            );
        }

        return true;
    }

    private static async _makeDeadWindowResponse(
        ah: Types.AbilityHelpers,
        beginData: CrossOriginStateData,
        transactions: CrossOriginTransactions,
        forwardResult: Promise<true | undefined>
    ): Promise<true> {
        const deadUId = beginData && beginData.ownerUId;

        if (deadUId) {
            transactions.removeTarget(deadUId);
        }

        return forwardResult.then(() => {
            if (deadUId === _focusOwner) {
                DeloserAPI.forceRestoreFocus(ah.deloser);
            }
            return true;
        });
    }

    private static async _makeKeyboardNavigationResponse(ah: Types.AbilityHelpers, isNavigatingWithKeyboard?: boolean): Promise<true> {
        if ((isNavigatingWithKeyboard !== undefined) && (ah.keyboardNavigation.isNavigatingWithKeyboard() !== isNavigatingWithKeyboard)) {
            _ignoreKeyboardNavigationStateUpdate = true;
            KeyboardNavigationState.setVal(ah.keyboardNavigation, isNavigatingWithKeyboard);
            _ignoreKeyboardNavigationStateUpdate = false;
        }
        return true;
    }

    private static async _makeOutlineResponse(ah: Types.AbilityHelpers, props?: Partial<Types.OutlineProps>): Promise<true> {
        if (_origOutlineSetup) {
            _origOutlineSetup.call(ah.outline, props);
        }
        return true;
    }
}

class GetElementTransaction extends CrossOriginTransaction<CrossOriginElementDataIn | undefined, CrossOriginElementDataOut> {
    type = Types.CrossOriginTransactionType.GetElement;

    static shouldSelfRespond = () => true;

    static findElement(ah: Types.AbilityHelpers, owner: Window, data?: CrossOriginElementDataIn): HTMLElement | null {
        let element: HTMLElement | null | undefined;

        if (data && (!data.ownerId || (data.ownerId === getWindowUId(owner)))) {
            if (data.id) {
                element = owner.document.getElementById(data.id);

                if (element && data.rootId) {
                    const ram = RootAPI.findRootAndModalizer(ah, element);

                    if (!ram || (ram.root.uid !== data.rootId)) {
                        return null;
                    }
                }
            } else if (data.uid) {
                element = elementByUId[data.uid];
            } else if (data.observedName) {
                element = ah.observedElement.getElement(data.observedName);
            }
        }

        return element || null;
    }

    static getElementData(
        abilityHelpers: Types.AbilityHelpers,
        element: HTMLElement,
        owner: Window,
        ownerUId: string
    ): CrossOriginElementDataOut {
        const deloser = DeloserAPI.getDeloser(abilityHelpers, element);
        const ram = RootAPI.findRootAndModalizer(abilityHelpers, element);
        const ah = getAbilityHelpersOnElement(abilityHelpers, element);
        const observed = ah && ah.observed;

        return {
            uid: getElementUId(element, owner),
            ownerUId,
            id: element.id || undefined,
            rootUId: ram ? ram.root.uid : undefined,
            deloserUId: deloser ? getDeloserUID(deloser, owner) : undefined,
            observedName: observed && observed.name,
            observedDetails: observed && observed.details
        };
    }

    static async makeResponse(
        ah: Types.AbilityHelpers,
        data: Types.CrossOriginTransactionData<CrossOriginElementDataIn | undefined, CrossOriginElementDataOut>,
        owner: Window,
        ownerUId: string,
        transactions: CrossOriginTransactions,
        forwardResult: Promise<CrossOriginElementDataOut | undefined>
    ): Promise<CrossOriginElementDataOut | undefined> {
        const beginData = data.beginData;
        let element: HTMLElement | undefined;
        let dataOut: CrossOriginElementDataOut | undefined;

        if (beginData === undefined) {
            element = ah.focusedElement.getFocusedElement();
        } else if (beginData) {
            element = GetElementTransaction.findElement(ah, owner, beginData) || undefined;
        }

        if (!element && beginData) {
            const name = beginData.observedName;
            const timeout = data.timeout;

            if (name && timeout) {
                const e: {
                    element?: HTMLElement | null,
                    crossOrigin?: CrossOriginElementDataOut
                } = await (new Promise((resolve, reject) => {
                    let isWaitElementResolved = false;
                    let isForwardResolved = false;
                    let isResolved = false;

                    ah.observedElement.waitElement(name, timeout).then(value => {
                        isWaitElementResolved = true;

                        if (!isResolved && (value || isForwardResolved)) {
                            isResolved = true;
                            resolve({ element: value });
                        }
                    });

                    forwardResult.then(value => {
                        isForwardResolved = true;

                        if (!isResolved && (value || isWaitElementResolved)) {
                            isResolved = true;
                            resolve({ crossOrigin: value });
                        }
                    });
                }));

                if (e.element) {
                    element = e.element;
                } else if (e.crossOrigin) {
                    dataOut = e.crossOrigin;
                }
            }
        }

        return element
            ? GetElementTransaction.getElementData(ah, element, owner, ownerUId)
            : dataOut;
    }
}

interface CrossOriginDeloser {
    ownerUId: string;
    deloserUId: string;
    rootUId: string;
}

interface RestoreFocusInDeloserTransactionData extends CrossOriginDeloser {
    reset: boolean;
}

class RestoreFocusInDeloserTransaction extends CrossOriginTransaction<RestoreFocusInDeloserTransactionData, boolean> {
    type = Types.CrossOriginTransactionType.RestoreFocusInDeloser;

    static async makeResponse(
        ah: Types.AbilityHelpers,
        data: Types.CrossOriginTransactionData<RestoreFocusInDeloserTransactionData, boolean>,
        owner: Window,
        ownerId: string,
        transactions: CrossOriginTransactions,
        forwardResult: Promise<boolean | undefined>
    ): Promise<boolean> {
        const forwardRet = await forwardResult;
        const begin = !forwardRet && data.beginData;
        const uid = begin && begin.deloserUId;
        const deloser = uid && _deloserByUId[uid];

        if (begin && deloser) {
            const history = DeloserAPI.getHistory(ah.deloser);

            return begin.reset ? history.resetFocus(deloser) : history.focusAvailable(deloser);
        }

        return !!forwardRet;
    }
}

class PingTransaction extends CrossOriginTransaction<undefined, true> {
    type = Types.CrossOriginTransactionType.Ping;

    static shouldForward() {
        return false;
    }

    static async makeResponse(): Promise<true> {
        return true;
    }
}

interface CrossOriginTransactionWrapper<I, O> {
    transaction: CrossOriginTransaction<I, O>;
    timer?: number;
}

class CrossOriginTransactions {
    private _owner: WindowWithUID;
    private _ownerUId: string;
    private _knownTargets: KnownTargets = {};
    private _transactions: { [id: string]: CrossOriginTransactionWrapper<any, any> } = {};
    private _ah: Types.AbilityHelpers;
    private _pingTimer: number | undefined;
    private _disposeTimer: number | undefined;
    private _isDefaultSendUp = false;
    isSetUp = false;
    sendUp: Types.CrossOriginTransactionSend | undefined;

    constructor(ah: Types.AbilityHelpers, owner: WindowWithUID) {
        this._ah = ah;
        this._owner = owner;
        this._ownerUId = getWindowUId(owner);
    }

    setup(sendUp?: Types.CrossOriginTransactionSend | null): (msg: Types.CrossOriginMessage) => void {
        if (this.isSetUp) {
            if (__DEV__) {
                console.error('CrossOrigin is already set up.');
            }
        } else {
            this.isSetUp = true;

            this.setSendUp(sendUp);

            this._owner.addEventListener('pagehide', this._onPageHide);

            this._ping();
        }

        return this._onMessage;
    }

    setSendUp(sendUp?: Types.CrossOriginTransactionSend | null): (msg: Types.CrossOriginMessage) => void {
        if (!this.isSetUp) {
            throw new Error('CrossOrigin is not set up.');
        }

        this.sendUp = sendUp || undefined;

        if (sendUp === undefined) {
            if (!this._isDefaultSendUp) {
                if (this._owner.document) {
                    this._isDefaultSendUp = true;

                    if (this._owner.parent && (this._owner.parent !== this._owner) && this._owner.parent.postMessage) {
                        this.sendUp = (data: Types.CrossOriginTransactionData<any, any>) => {
                            this._owner.parent.postMessage(JSON.stringify(data), '*');
                        };
                    }

                    this._owner.addEventListener('message', this._onBrowserMessage);
                }
            }
        } else if (this._isDefaultSendUp) {
            this._owner.removeEventListener('message', this._onBrowserMessage);
            this._isDefaultSendUp = false;
        }

        return this._onMessage;
    }

    dispose(): void {
        if (this._pingTimer) {
            this._owner.clearTimeout(this._pingTimer);
            this._pingTimer = undefined;
        }

        this._owner.removeEventListener('message', this._onBrowserMessage);
        this._owner.removeEventListener('pagehide', this._onPageHide);

        if (!this._disposeTimer) {
            // Giving a bit to send DeadWindow transaction before actually
            // killing all references.
            this._disposeTimer = this._owner.setTimeout(() => {
                this._disposeTimer = undefined;

                for (let id of Object.keys(this._transactions)) {
                    const t = this._transactions[id];

                    if (t.timer) {
                        this._owner.clearTimeout(t.timer);
                        delete t.timer;
                    }

                    t.transaction.end();
                }

                this._knownTargets = {};

                delete this.sendUp;
            }, 500);
        }
    }

    beginTransaction<I, O>(
        Transaction: CrossOriginTransactionClass<I, O>,
        value: I,
        timeout?: number,
        sentTo?: Types.CrossOriginSentTo,
        targetId?: string,
        withReject?: boolean
    ): Promise<O | undefined> {
        if (!this._owner) {
            return Promise.reject();
        }

        const transaction = new Transaction(this._ah, this._owner, this._knownTargets, value, timeout, sentTo, targetId, this.sendUp);
        let selfResponse: ((data: Types.CrossOriginTransactionData<I, O>) => Promise<O | undefined>) | undefined;

        if (Transaction.shouldSelfRespond && Transaction.shouldSelfRespond(this._ah, value, this._owner, this._ownerUId)) {
            selfResponse = (data: Types.CrossOriginTransactionData<I, O>) => {
                return Transaction.makeResponse(
                    this._ah,
                    data,
                    this._owner,
                    this._ownerUId,
                    this,
                    Promise.resolve(undefined),
                    true
                );
            };
        }

        return this._beginTransaction(transaction, timeout, selfResponse, withReject);
    }

    removeTarget(uid: string): void {
        delete this._knownTargets[uid];
    }

    private _beginTransaction<I, O>(
        transaction: CrossOriginTransaction<I, O>,
        timeout?: number,
        selfResponse?: (data: Types.CrossOriginTransactionData<I, O>) => Promise<O | undefined>,
        withReject?: boolean
    ): Promise<O | undefined> {
        const wrapper: CrossOriginTransactionWrapper<I, O> = {
            transaction,
            timer: this._owner.setTimeout(() => {
                delete wrapper.timer;
                transaction.end('Cross origin transaction timed out.');
            }, _transactionTimeout + (timeout || 0))
        };

        this._transactions[transaction.id] = wrapper;

        const ret = transaction.begin(selfResponse);

        ret.finally(() => {
            if (this._transactions) { // Making sure we're not accessing it after dispose().
                if (wrapper.timer) {
                    this._owner.clearTimeout(wrapper.timer);
                }
                delete this._transactions[transaction.id];
            }
        });

        return ret.then(value => value, withReject ? undefined : () => undefined);
    }

    forwardTransaction(data: Types.CrossOriginTransactionData<any, any>): Promise<any> {
        let targetId = data.target;

        if (targetId === this._ownerUId) {
            return Promise.resolve();
        }

        const Transaction = this._getTransactionClass(data.type);

        if (Transaction) {
            if ((Transaction.shouldForward === undefined) || (Transaction.shouldForward(this._ah, data, this._owner, this._ownerUId))) {
                const sentTo = data.sentto;

                if (targetId === _targetIdUp) {
                    targetId = undefined;
                    sentTo[this._ownerUId] = true;
                }

                delete sentTo[_targetIdUp];

                return this._beginTransaction(
                    new Transaction(
                        this._ah,
                        this._owner,
                        this._knownTargets,
                        data.beginData,
                        data.timeout,
                        sentTo,
                        targetId,
                        this.sendUp
                    ),
                    data.timeout
                );
            } else {
                return Promise.resolve();
            }
        }

        return Promise.reject(`Unknown transaction type ${ data.type }`);
    }

    private _getTransactionClass(type: Types.CrossOriginTransactionType): CrossOriginTransactionClass<any, any> | null {
        switch (type) {
            case Types.CrossOriginTransactionType.Bootstrap:
                return BootstrapTransaction;
            case Types.CrossOriginTransactionType.FocusElement:
                return FocusElementTransaction;
            case Types.CrossOriginTransactionType.State:
                return StateTransaction;
            case Types.CrossOriginTransactionType.GetElement:
                return GetElementTransaction;
            case Types.CrossOriginTransactionType.RestoreFocusInDeloser:
                return RestoreFocusInDeloserTransaction;
            case Types.CrossOriginTransactionType.Ping:
                return PingTransaction;
            default:
                return null;
        }
    }

    private _onMessage = (e: Types.CrossOriginMessage) => {
        if ((e.data.owner === this._ownerUId) || !this._ah) {
            return;
        }

        let data: Types.CrossOriginTransactionData<any, any> = e.data;
        let transactionId: string;

        if (
            !data ||
            !((transactionId = data.transaction)) ||
            !data.type ||
            !data.timestamp ||
            !data.owner ||
            !data.sentto
        ) {
            return;
        }

        let knownTarget = this._knownTargets[data.owner];

        if (!knownTarget && e.send && (data.owner !== this._ownerUId)) {
            knownTarget = this._knownTargets[data.owner] = { send: e.send };
        }

        if (knownTarget) {
            knownTarget.last = Date.now();
        }

        if (data.isResponse) {
            const t = this._transactions[transactionId];

            if (t && t.transaction && (t.transaction.type === data.type)) {
                t.transaction.onResponse(data);
            }
        } else {
            const Transaction = this._getTransactionClass(data.type);

            const forwardResult = this.forwardTransaction(data);

            if (Transaction && e.send) {
                Transaction.makeResponse(this._ah, data, this._owner, this._ownerUId, this, forwardResult, false).then(r => {
                    const response: Types.CrossOriginTransactionData<any, any> = {
                        transaction: data.transaction,
                        type: data.type,
                        isResponse: true,
                        timestamp: Date.now(),
                        owner: this._ownerUId,
                        timeout: data.timeout,
                        sentto: {},
                        target: (data.target === _targetIdUp) ? _targetIdUp : data.owner,
                        endData: r
                    };

                    e.send(response);
                });
            }
        }
    }

    private _onPageHide = async () => {
        if (_focusOwner === this._ownerUId) {
            await this.beginTransaction(StateTransaction, {
                ownerUId: this._ownerUId,
                state: CrossOriginState.DeadWindow
            });
        }
    }

    private async _ping(): Promise<void> {
        if (this._pingTimer) {
            return;
        }

        let deadWindows: { [key: string]: boolean } | undefined;
        const now = Date.now();
        const targets = Object.keys(this._knownTargets).filter(uid => (now - (this._knownTargets[uid].last || 0)) > _pingTimeout);

        if (this.sendUp) {
            targets.push(_targetIdUp);
        }

        if (targets.length) {
            await Promise.all(
                targets.map(
                    uid => this.beginTransaction(PingTransaction, undefined, undefined, undefined, uid, true).then(() => true, () => {
                        if (uid !== _targetIdUp) {
                            if (!deadWindows) {
                                deadWindows = {};
                            }
                            deadWindows[uid] = true;
                            delete this._knownTargets[uid];
                        }
                        return false;
                    })
                )
            );
        }

        if (deadWindows) {
            const focused = await this.beginTransaction(GetElementTransaction, undefined);

            if (!focused && _focusOwner && (_focusOwner in deadWindows)) {
                await this.beginTransaction(StateTransaction, {
                    ownerUId: this._ownerUId,
                    state: CrossOriginState.Blurred,
                    force: true
                });

                DeloserAPI.forceRestoreFocus(this._ah.deloser);
            }
        }

        this._pingTimer = this._owner.setTimeout(() => {
            this._pingTimer = undefined;
            this._ping();
        }, _pingTimeout);
    }

    private _onBrowserMessage = (e: MessageEvent) => {
        if (e.source === this._owner) {
            return;
        }

        const send = (data: Types.CrossOriginTransactionData<any, any>) => {
            if (e.source && e.source.postMessage) {
                (e.source.postMessage as Function)(JSON.stringify(data), '*');
            }
        };

        try {
            this._onMessage({
                data: JSON.parse(e.data),
                send
            });
        } catch (e) { /* Ignore */ }
    }
}

export class CrossOriginElement implements Types.CrossOriginElement {
    private _ah: Types.AbilityHelpers;
    readonly uid: string;
    readonly ownerId: string;
    readonly id?: string;
    readonly rootId?: string;
    readonly observedName?: string;
    readonly observedDetails?: string;

    constructor(
        ah: Types.AbilityHelpers,
        uid: string,
        ownerId: string,
        id?: string,
        rootId?: string,
        observedName?: string,
        observedDetails?: string
    ) {
        this._ah = ah;
        this.uid = uid;
        this.ownerId = ownerId;
        this.id = id;
        this.rootId = rootId;
        this.observedName = observedName;
        this.observedDetails = observedDetails;
    }

    focus(noFocusedProgrammaticallyFlag?: boolean, noAccessibleCheck?: boolean): Promise<boolean> {
        return this._ah.crossOrigin.focusedElement.focus(this, noFocusedProgrammaticallyFlag, noAccessibleCheck);
    }
}

export class CrossOriginFocusedElementState
        extends Subscribable<CrossOriginElement | undefined, Types.FocusedElementDetails>
        implements Types.CrossOriginFocusedElementState {

    private _transactions: CrossOriginTransactions;

    constructor(transactions: CrossOriginTransactions) {
        super();
        this._transactions = transactions;
    }

    protected dispose() {
        super.dispose();
    }

    static dispose(instance: Types.CrossOriginFocusedElementState) {
        (instance as CrossOriginFocusedElementState).dispose();
    }

    async focus(
        element: Types.CrossOriginElement,
        noFocusedProgrammaticallyFlag?: boolean,
        noAccessibleCheck?: boolean
    ): Promise<boolean> {
        return this._focus(
            {
                uid: element.uid,
                id: element.id,
                rootId: element.rootId,
                ownerId: element.ownerId,
                observedName: element.observedName
            },
            noFocusedProgrammaticallyFlag,
            noAccessibleCheck
        );
    }

    async focusById(
        elementId: string,
        rootId?: string,
        noFocusedProgrammaticallyFlag?: boolean,
        noAccessibleCheck?: boolean
    ): Promise<boolean> {
        return this._focus({ id: elementId, rootId }, noFocusedProgrammaticallyFlag, noAccessibleCheck);
    }

    async focusByObservedName(
        observedName: string,
        timeout?: number,
        rootId?: string,
        noFocusedProgrammaticallyFlag?: boolean,
        noAccessibleCheck?: boolean
    ): Promise<boolean> {
        return this._focus({ observedName, rootId }, noFocusedProgrammaticallyFlag, noAccessibleCheck, timeout);
    }

    private async _focus(
        elementData: CrossOriginElementDataIn,
        noFocusedProgrammaticallyFlag?: boolean,
        noAccessibleCheck?: boolean,
        timeout?: number
    ): Promise<boolean> {
        return this._transactions.beginTransaction(FocusElementTransaction, {
            ...elementData,
            noFocusedProgrammaticallyFlag,
            noAccessibleCheck
        }, timeout).then(value => !!value);
    }

    static setVal(
        instance: Types.CrossOriginFocusedElementState,
        val: CrossOriginElement | undefined,
        details: Types.FocusedElementDetails
    ): void {
        (instance as CrossOriginFocusedElementState).setVal(val, details);
    }
}

export class CrossOriginObservedElementState
        extends Subscribable<CrossOriginElement, Types.ObservedElementBasicProps>
        implements Types.CrossOriginObservedElementState {

    private _ah: Types.AbilityHelpers;
    private _transactions: CrossOriginTransactions;
    private _lastRequestFocusId = 0;

    constructor(ah: Types.AbilityHelpers, transactions: CrossOriginTransactions) {
        super();
        this._ah = ah;
        this._transactions = transactions;
    }

    protected dispose() {
        super.dispose();
    }

    static dispose(instance: Types.CrossOriginObservedElementState) {
        (instance as CrossOriginObservedElementState).dispose();
    }

    async getElement(observedName: string): Promise<CrossOriginElement | null> {
        return this.waitElement(observedName, 0);
    }

    async waitElement(observedName: string, timeout: number): Promise<CrossOriginElement | null> {
        return this._transactions.beginTransaction(GetElementTransaction, {
            observedName: observedName
        }, timeout).then(value => value ? StateTransaction.createElement(this._ah, value) : null);
    }

    async requestFocus(observedName: string, timeout: number): Promise<boolean> {
        let requestId = ++this._lastRequestFocusId;
        return this.waitElement(observedName, timeout).then(element => ((this._lastRequestFocusId === requestId) && element)
            ? this._ah.crossOrigin.focusedElement.focus(element)
            : false
        );
    }

    static trigger(
        instance: Types.CrossOriginObservedElementState,
        element: CrossOriginElement,
        details: Types.ObservedElementBasicProps
    ): void {
        (instance as CrossOriginObservedElementState).trigger(element, details);
    }
}

export class CrossOriginAPI implements Types.CrossOriginAPI {
    private _ah: Types.AbilityHelpers;
    private _initTimer: number | undefined;
    private _win: WindowWithUID;
    private _transactions: CrossOriginTransactions;
    private _blurTimer: number | undefined;

    focusedElement: Types.CrossOriginFocusedElementState;
    observedElement: Types.CrossOriginObservedElementState;

    constructor(ah: Types.AbilityHelpers, mainWindow: Window) {
        this._ah = ah;
        this._win = mainWindow;
        this._transactions = new CrossOriginTransactions(ah, mainWindow);
        this.focusedElement = new CrossOriginFocusedElementState(this._transactions);
        this.observedElement = new CrossOriginObservedElementState(ah, this._transactions);
    }

    setup(sendUp?: Types.CrossOriginTransactionSend | null): (msg: Types.CrossOriginMessage) => void {
        if (this.isSetUp()) {
            return this._transactions.setSendUp(sendUp);
        } else {
            this._initTimer = this._win.setTimeout(this._init, 0);
            return this._transactions.setup(sendUp);
        }
    }

    isSetUp(): boolean {
        return this._transactions.isSetUp;
    }

    private _init = (): void => {
        this._initTimer = undefined;

        const ah = this._ah;

        ah.keyboardNavigation.subscribe(this._onKeyboardNavigationStateChanged);
        ah.focusedElement.subscribe(this._onFocus);
        ah.observedElement.subscribe(this._onObserved);

        if (!_origOutlineSetup) {
            _origOutlineSetup = ah.outline.setup;
            ah.outline.setup = this._outlineSetup;
        }

        this._transactions.beginTransaction(BootstrapTransaction, undefined, undefined, undefined, _targetIdUp).then(data => {
            if (data && (this._ah.keyboardNavigation.isNavigatingWithKeyboard() !== data.isNavigatingWithKeyboard)) {
                _ignoreKeyboardNavigationStateUpdate = true;
                KeyboardNavigationState.setVal(this._ah.keyboardNavigation, data.isNavigatingWithKeyboard);
                _ignoreKeyboardNavigationStateUpdate = false;
            }
        });
    }

    protected dispose(): void {
        if (this._initTimer) {
            this._win.clearTimeout(this._initTimer);
            this._initTimer = undefined;
        }

        const ah = this._ah;

        ah.keyboardNavigation.unsubscribe(this._onKeyboardNavigationStateChanged);
        ah.focusedElement.unsubscribe(this._onFocus);
        ah.observedElement.unsubscribe(this._onObserved);

        this._transactions.dispose();
        CrossOriginFocusedElementState.dispose(this.focusedElement);
        CrossOriginObservedElementState.dispose(this.observedElement);
    }

    static dispose(instance: Types.CrossOriginAPI) {
        (instance as CrossOriginAPI).dispose();
    }

    private _onKeyboardNavigationStateChanged = (value: boolean): void => {
        if (!_ignoreKeyboardNavigationStateUpdate) {
            this._transactions.beginTransaction(StateTransaction, {
                state: CrossOriginState.KeyboardNavigation,
                ownerUId: getWindowUId(this._win),
                isNavigatingWithKeyboard: value
            });
        }
    }

    private _onFocus = (element: HTMLElementWithUID | undefined, details: Types.FocusedElementDetails): void => {
        let ownerUId = getWindowUId(this._win);

        if (this._blurTimer) {
            this._win.clearTimeout(this._blurTimer);
            this._blurTimer = undefined;
        }

        if (element) {
            this._transactions.beginTransaction(
                StateTransaction,
                { ...GetElementTransaction.getElementData(this._ah, element, this._win, ownerUId), state: CrossOriginState.Focused }
            );
        } else {
            this._blurTimer = this._win.setTimeout(() => {
                this._blurTimer = undefined;

                if (_focusOwner && (_focusOwner === ownerUId)) {
                    this._transactions.beginTransaction(GetElementTransaction, undefined).then(value => {
                        if (!value && (_focusOwner === ownerUId)) {
                            this._transactions.beginTransaction(StateTransaction, {
                                ownerUId,
                                state: CrossOriginState.Blurred,
                                force: false
                            });
                        }
                    });
                }
            }, 0);
        }
    }

    private _onObserved = (element: HTMLElement, details: Types.ObservedElementBasicProps): void => {
        const d = GetElementTransaction.getElementData(
            this._ah,
            element,
            this._win,
            getWindowUId(this._win)
        ) as CrossOriginStateData;

        d.state = CrossOriginState.Observed;
        d.observedName = details.name;
        d.observedDetails = details.details;

        this._transactions.beginTransaction(StateTransaction, d);
    }

    private _outlineSetup = (props?: Partial<Types.OutlineProps>): void => {
        this._transactions.beginTransaction(StateTransaction, {
            state: CrossOriginState.Outline,
            ownerUId: getWindowUId(this._win),
            outline: props
        });
    }
}

function getDeloserUID(deloser: Types.Deloser, window: Window): string {
    const uid = getElementUId(deloser.getElement(), window);

    if (!_deloserByUId[uid]) {
        _deloserByUId[uid] = deloser;
    }

    return uid;
}
