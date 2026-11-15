"use client";

import { Button, Checkbox, CheckboxGroup, Radio, RadioGroup } from "@heroui/react";
import {
  answeredAll,
  type ClarifyOutcome,
  type ClarifyQuestion,
  clarifyAnswer,
  clarifyQuestions,
  onePress,
} from "@opendash/core/clarify";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { optionViews } from "@/lib/clarify-options";

/**
 * What the agent asked back. One question with one pick is answered by a press, as before: its options in a
 * row, or a dashboard's as stacked rows. Otherwise the questions stack in the card, each with its radio group or
 * checkboxes, and Send once each has a pick; the picks are the person's next message, a line a question. An older ask,
 * or a shared conversation, is shown but can't be answered.
 */
export function ClarifyCard({
  outcome,
  can,
  onAsk,
}: {
  outcome: ClarifyOutcome;
  /** Whether it can be answered: the latest ask, in a conversation the reader may add to. */
  can: boolean;
  onAsk?: (text: string) => void;
}) {
  const questions = clarifyQuestions(outcome);
  const only = questions[0];
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border px-4 py-3.5">
      {only && onePress(questions) ? (
        <OnePress question={only} can={can} onAsk={onAsk} />
      ) : (
        <Questions questions={questions} can={can} onAsk={onAsk} />
      )}
      {onAsk ? <p className="text-small text-muted-tertiary">Or answer in your own words below.</p> : null}
    </div>
  );
}

function OnePress({
  question,
  can,
  onAsk,
}: {
  question: ClarifyQuestion;
  can: boolean;
  onAsk?: (text: string) => void;
}) {
  const choices = optionViews(question.options);
  return (
    <>
      <p className="text-lead font-medium">{question.question}</p>
      {choices.stacked ? (
        // Dashboards to choose from, each a row: its title, what it holds and its filter.
        <div className="flex flex-col gap-2">
          {choices.options.map((o) => (
            <button
              key={o.text}
              type="button"
              disabled={!can}
              onClick={() => onAsk?.(o.text)}
              className="group flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-left enabled:hover:border-accent disabled:opacity-60"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium">{o.title}</span>
                {o.detail ? <span className="text-small text-muted">{o.detail}</span> : null}
              </span>
              <ArrowRight
                className="size-3.5 shrink-0 text-muted-tertiary group-enabled:group-hover:text-accent"
                aria-hidden
              />
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {choices.options.map((o) => (
            <Button key={o.text} size="sm" variant="outline" isDisabled={!can} onPress={() => onAsk?.(o.text)}>
              {o.title}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

function Questions({
  questions,
  can,
  onAsk,
}: {
  questions: ClarifyQuestion[];
  can: boolean;
  onAsk?: (text: string) => void;
}) {
  // The picks stay in the page until Send: each question's chosen options, by place.
  const [picks, setPicks] = useState<number[][]>(() => questions.map(() => []));
  const pick = (i: number, chosen: number[]) => setPicks((p) => p.map((was, k) => (k === i ? chosen : was)));
  const several = questions.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {questions.map((q, i) => {
        const label = (
          <p className="text-body font-medium">
            {several ? <span className="text-muted-tertiary">{i + 1}. </span> : null}
            {q.question}
          </p>
        );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: questions are positional (two may be worded alike) and never reorder
          <div key={i} className="flex flex-col gap-1.5">
            {label}
            {q.multiple ? (
              <CheckboxGroup
                aria-label={q.question}
                isDisabled={!can}
                value={(picks[i] ?? []).map(String)}
                onChange={(next) => pick(i, next.map(Number))}
                className="flex flex-col gap-0.5"
              >
                {q.options.map((o, k) => (
                  <Checkbox key={o} value={String(k)} className="mt-0 rounded-lg px-1.5 py-1.5 hover:bg-default">
                    <Checkbox.Content className="items-start text-body">
                      <Checkbox.Control className="mt-0.5">
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span>{o}</span>
                    </Checkbox.Content>
                  </Checkbox>
                ))}
              </CheckboxGroup>
            ) : (
              <RadioGroup
                aria-label={q.question}
                isDisabled={!can}
                value={picks[i]?.[0] === undefined ? null : String(picks[i]?.[0])}
                onChange={(next) => pick(i, [Number(next)])}
                className="flex flex-col gap-0.5"
              >
                {q.options.map((o, k) => (
                  <Radio key={o} value={String(k)} className="mt-0 rounded-lg px-1.5 py-1.5 hover:bg-default">
                    <Radio.Content className="flex items-start gap-2.5 text-body">
                      <Radio.Control className="mt-0.5">
                        <Radio.Indicator />
                      </Radio.Control>
                      <span>{o}</span>
                    </Radio.Content>
                  </Radio>
                ))}
              </RadioGroup>
            )}
          </div>
        );
      })}
      {can ? (
        <div>
          <Button
            size="sm"
            variant="primary"
            isDisabled={!answeredAll(questions, picks)}
            onPress={() => onAsk?.(clarifyAnswer(questions, picks))}
          >
            Send
          </Button>
        </div>
      ) : null}
    </div>
  );
}
