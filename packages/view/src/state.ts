// SPDX-License-Identifier: MIT
export interface StateAction {
  type: string;
  args?: any;
}

export interface State<T = any> {
  apply(action: StateAction): void;
  readonly data: T;
}

export const createState = <T = any>(
  initial: T,
  reducer: (data: T, action: StateAction) => T,
): State<T> => {
  let data = initial;
  return {
    apply(action: StateAction) {
      data = reducer(data, action);
    },
    get data() {
      return data;
    },
  };
};
