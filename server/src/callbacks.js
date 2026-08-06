import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import _ from "lodash";
import taskConfig from "./HPTConfig.json";

export const Empirica = new ClassicListenersCollector();

Empirica.onGameStart(({ game }) => {
  const {
    gameDuration,
    introDuration,
    fullInfo = false,
  } = game.get("treatment");

  const players = game.players;
  const shuffledProfiles = _.shuffle(taskConfig.playerConfig);

  if (players.length > shuffledProfiles.length) {
    throw new Error(
      `Treatment requested ${players.length} players, but HPTConfig.json only defines ${shuffledProfiles.length} profiles.`,
    );
  }

  game.set("generalInfo", taskConfig.generalInfo);

  const round = game.addRound({ name: "Round 1" });
  round.addStage({ name: "transitionToIntroduction", duration: 10 });
  round.addStage({ name: "Introduction", duration: introDuration * 60 });
  round.addStage({ name: "transitionToTask", duration: 10 });
  round.addStage({ name: "Task", duration: gameDuration * 60 });

  players.forEach((player, index) => {
    const profile = shuffledProfiles[index];
    player.set("name", profile.playerName);
    player.set(
      "playerContent",
      fullInfo ? profile.playerContent_fullinfo : profile.playerContent,
    );
    player.set("hexCode", profile.hexCode);
  });
});

Empirica.onStageStart(({ stage }) => {
  if (stage.get("name") !== "Task") {
    return;
  }

  const game = stage.currentGame;
  const { gameDuration } = game.get("treatment");
  const taskStartTime = Date.now();

  game.set("taskStartTime", taskStartTime);
  game.set("deadline", taskStartTime + gameDuration * 60 * 1000);
});
