'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError, api, newKey } from './api';
import type { Order, OrderItem, OrderStatus, OrderType } from './types';

export interface ItemInput {
  productId: string;
  variantId?: string;
  quantity: string;
  modifiers?: { modifierId: string }[];
  instructions?: string;
}

export interface NewOrderContext {
  branchId: string;
  orderType: OrderType;
  tableId?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
}

/** An item the kitchen has not seen yet can still be changed freely. */
export const isUnsent = (i: OrderItem) => i.status === 'ACTIVE' && i.ticketItems.length === 0;

/**
 * The order being rung up. Every change goes to the server, which prices it and returns the new
 * totals; nothing is calculated here. Changes run one at a time, each against the latest version,
 * so fast taps never race each other. If another device changed the order first, the order is
 * reloaded and the tap is reported, not silently dropped.
 */
export function useOrder(initial: Order | null, onChange?: (o: Order) => void) {
  const qc = useQueryClient();
  const [order, setOrderState] = useState<Order | null>(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<Order | null>(initial);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  // The key for creating this order is fixed until it exists, so a retried first tap never makes two orders.
  const createKey = useRef(newKey());

  const setOrder = useCallback(
    (o: Order | null) => {
      ref.current = o;
      setOrderState(o);
      if (o) {
        qc.setQueryData(['order', o.id], o);
        onChange?.(o);
      }
    },
    [qc, onChange],
  );

  const run = useCallback(
    <T,>(fn: (current: Order | null) => Promise<T>): Promise<T> => {
      pending.current++;
      setBusy(true);
      const p = chain.current.then(async () => {
        try {
          return await fn(ref.current);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'CONCURRENT_UPDATE' && ref.current) {
            setOrder(await api.get<Order>(`/orders/${ref.current.id}`));
          }
          throw err;
        } finally {
          if (--pending.current === 0) setBusy(false);
        }
      });
      chain.current = p.catch(() => undefined);
      return p;
    },
    [setOrder],
  );

  const reload = useCallback(async () => {
    if (ref.current) setOrder(await api.get<Order>(`/orders/${ref.current.id}`));
  }, [setOrder]);

  const addItem = useCallback(
    (ctx: NewOrderContext, item: ItemInput) =>
      run(async (cur) => {
        if (!cur) {
          const o = await api.post<Order>('/orders', { ...ctx, items: [item] }, createKey.current);
          setOrder(o);
          return o;
        }
        const o = await api.patch<Order>(`/orders/${cur.id}`, { version: cur.version, addItems: [item] });
        setOrder(o);
        return o;
      }),
    [run, setOrder],
  );

  const setQuantity = useCallback(
    (itemId: string, quantity: string) =>
      run(async (cur) => {
        if (!cur) return null;
        const body =
          Number(quantity) <= 0
            ? { version: cur.version, removeItems: [{ itemId, reason: 'Removed before sending to kitchen' }] }
            : { version: cur.version, updateItems: [{ itemId, quantity }] };
        const o = await api.patch<Order>(`/orders/${cur.id}`, body);
        setOrder(o);
        return o;
      }),
    [run, setOrder],
  );

  const removeItem = useCallback(
    (itemId: string, reason: string) =>
      run(async (cur) => {
        if (!cur) return null;
        const o = await api.patch<Order>(`/orders/${cur.id}`, { version: cur.version, removeItems: [{ itemId, reason }] });
        setOrder(o);
        return o;
      }),
    [run, setOrder],
  );

  /** Sends new items to the kitchen: the first time confirms the order, later times send a new KOT. */
  const sendToKitchen = useCallback(
    () =>
      run(async (cur) => {
        if (!cur) return null;
        const path = cur.status === 'NEW' ? `/orders/${cur.id}/confirm` : `/orders/${cur.id}/kot`;
        const o = await api.post<Order>(path, { version: cur.version });
        setOrder(o);
        return o;
      }),
    [run, setOrder],
  );

  /** Moves the order along its flow (served, handed over, out for delivery…). */
  const setStatus = useCallback(
    (status: OrderStatus) =>
      run(async (cur) => {
        if (!cur) return null;
        const o = await api.post<Order>(`/orders/${cur.id}/status`, { version: cur.version, status });
        setOrder(o);
        return o;
      }),
    [run, setOrder],
  );

  const update = useCallback(
    (fields: { customerName?: string; customerPhone?: string; notes?: string }) =>
      run(async (cur) => {
        if (!cur) return null;
        const o = await api.patch<Order>(`/orders/${cur.id}`, { version: cur.version, ...fields });
        setOrder(o);
        return o;
      }),
    [run, setOrder],
  );

  const reset = useCallback(() => {
    createKey.current = newKey();
    setOrder(null);
  }, [setOrder]);

  return { order, busy, setOrder, reload, addItem, setQuantity, removeItem, sendToKitchen, setStatus, update, reset };
}
