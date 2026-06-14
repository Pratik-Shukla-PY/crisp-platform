/**
 * DynamicModuleRenderer - RN mirror of the PWA's _renderCrisisPackView
 * (mobile-app/src/v4-flow.js). Renders a geo-scoped crisis pack's extra
 * Stage-2/3 questions (the fields the hardcoded classify chips don't capture)
 * for the 'crisispack' classify sub-step. Field labels localize via
 * cp_<fieldkey>; select options via cpopt_<fieldkey>_<VALUE>; yes/no via
 * v4_yes/v4_no - all present in the 22 RN locales (RNV4-P0). Answers are written
 * back through onSetAnswer(key, value); the parent (App.tsx) holds
 * crisisStockAnswers, which feeds form_data at submit (RNV4-P2).
 *
 * Pure presentational component (no I/O, no navigation). The field list is
 * pre-filtered by services/crisisForm.ts::crisisPackRenderableFields.
 */
import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

function ti(key: string, fallback: string): string {
  const v = t(key);
  return v && v !== key ? v : fallback;
}

// Field label: cp_<key> → bare <key> → field.label → field.key. Mirror _cpLabel.
function fieldLabel(f: any): string {
  for (const k of [`cp_${f.key}`, f.key]) {
    const v = t(k);
    if (v && v !== k) return v;
  }
  return f.label || f.key;
}

// Option label: cpopt_<key>_<VALUE> → opt.label → opt.value. Mirror _cpOptLabel.
function optLabel(fieldKey: string, opt: { value: string; label?: string }): string {
  const k = `cpopt_${fieldKey}_${opt.value}`;
  const v = t(k);
  if (v && v !== k) return v;
  return opt.label || opt.value;
}

export interface DynamicModuleRendererProps {
  fields: any[];
  answers: Record<string, any>;
  onSetAnswer: (key: string, value: any) => void;
  title?: string | null;
}

export default function DynamicModuleRenderer(props: DynamicModuleRendererProps) {
  const { fields, answers, onSetAnswer } = props;
  return (
    <View testID="v4-crisispack">
      {props.title ? <Text style={styles.heading}>{props.title}</Text> : null}
      {fields.map((f) => {
        const cur = answers[f.key];
        return (
          <View key={f.key} style={styles.q} testID={`cp-q-${f.key}`}>
            <Text style={styles.label}>
              {fieldLabel(f)}
              {f.required ? <Text style={styles.req}> *</Text> : null}
            </Text>

            {f.type === 'yes_no' ? (
              <View style={styles.optsRow}>
                {([{ raw: 'yes', val: true }, { raw: 'no', val: false }] as const).map(({ raw, val }) => {
                  const sel = cur === val;
                  return (
                    <TouchableOpacity
                      key={raw}
                      style={[styles.opt, sel && styles.optSel]}
                      onPress={() => onSetAnswer(f.key, val)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel }}
                      testID={`cp-${f.key}-${raw}`}
                    >
                      <Text style={[styles.optText, sel && styles.optTextSel]}>
                        {ti(val ? 'v4_yes' : 'v4_no', val ? 'Yes' : 'No')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : f.type === 'single_select' || f.type === 'multi_select' ? (
              <View style={styles.optsWrap}>
                {(f.options || []).map((o: any) => {
                  const isMulti = f.type === 'multi_select';
                  const sel = isMulti ? Array.isArray(cur) && cur.indexOf(o.value) >= 0 : cur === o.value;
                  return (
                    <TouchableOpacity
                      key={o.value}
                      style={[styles.opt, sel && styles.optSel]}
                      onPress={() => {
                        if (isMulti) {
                          const arr = Array.isArray(cur) ? cur.slice() : [];
                          const i = arr.indexOf(o.value);
                          if (i >= 0) arr.splice(i, 1); else arr.push(o.value);
                          onSetAnswer(f.key, arr);
                        } else {
                          onSetAnswer(f.key, o.value);
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel }}
                      testID={`cp-${f.key}-${o.value}`}
                    >
                      <Text style={[styles.optText, sel && styles.optTextSel]}>{optLabel(f.key, o)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : f.type === 'integer' ? (
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={cur == null ? '' : String(cur)}
                onChangeText={(txt) => {
                  const n = parseInt(txt, 10);
                  onSetAnswer(f.key, isNaN(n) ? null : n);
                }}
                placeholderTextColor={Colors.textDim}
                testID={`cp-${f.key}-input`}
              />
            ) : (
              <TextInput
                style={[styles.input, f.type === 'long_text' && styles.inputMulti]}
                multiline={f.type === 'long_text'}
                value={cur == null ? '' : String(cur)}
                onChangeText={(txt) => onSetAnswer(f.key, txt)}
                placeholderTextColor={Colors.textDim}
                testID={`cp-${f.key}-input`}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', color: Colors.text, marginBottom: 14 },
  q: { marginBottom: 18 },
  label: { fontSize: 15, fontWeight: '600', color: Colors.text, marginBottom: 8 },
  req: { color: Colors.red },
  optsRow: { flexDirection: 'row', gap: 8 },
  optsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opt: {
    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
    minHeight: 44, justifyContent: 'center',
  },
  optSel: { borderColor: Colors.accent, backgroundColor: Colors.accent + '22' },
  optText: { fontSize: 14, color: Colors.text },
  optTextSel: { color: Colors.accent, fontWeight: '700' },
  input: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, color: Colors.text,
    backgroundColor: Colors.surface, fontSize: 15,
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
});
